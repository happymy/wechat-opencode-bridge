import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const SERVER = process.env.OPENCODE_SERVER || 'http://localhost:4096';
const AUTH = 'Basic ' + Buffer.from(process.env.OPENCODE_AUTH || 'opencode:opencode').toString('base64');
const WORK_DIR = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = join(WORK_DIR, '.wechat-session.json');
const SUBSCRIBERS_FILE = join(WORK_DIR, '.wechat-subscribers.json');
const WORKSPACES_FILE = join(WORK_DIR, '.wechat-workspaces.json');
const WORKSPACE_CURRENT_FILE = join(WORK_DIR, '.wechat-workspace-current.json');

const rl = createInterface({ input: process.stdin });
let currentSessionId = loadSession();
let currentWorkspace = loadDefaultWorkspace();
let currentAgent = 'build';
let lineBuf = '';
let subscribers = [];
let sessionStates = new Map();
let pendingNotifications = [];
let pendingPermissions = new Map();
let draining = false;

/* ───────── Logging ───────── */

const logFile = join(WORK_DIR, '.wechat-adapter.log');
function log(...args) {
  const line = `[wechat] ${args.join(' ')}`;
  process.stderr.write(line + '\n');
  try {
    writeFileSync(logFile, line + '\n', { flag: 'a' });
  } catch {}
}
function uuid() { return randomUUID() || 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

/* ───────── ACP Protocol ───────── */

rl.on('line', (line) => {
  if (lineBuf.length > 65536) { log('[WARN] lineBuf overflow, clearing'); lineBuf = ''; }
  lineBuf += line;
  let msg;
  try { msg = JSON.parse(lineBuf); lineBuf = ''; } catch { return; }
  const m = msg.method;
  log(`← ${m} id=${msg.id}`);

  if (m === 'initialize' && msg.id != null) {
    sendResponse(msg.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { audio: false, embeddedContext: false, image: false },
        sessionCapabilities: { list: {} },
      },
      agentInfo: { name: 'opencode-wechat-bot', version: '4.0.0' },
    });
  } else if (m === 'session/new') {
    handleNewSession(msg).catch(e => log(`[ERR] session/new: ${e.message}`));
  } else if (m === 'session/list') {
    handleListSessions(msg).catch(e => log(`[ERR] session/list: ${e.message}`));
  } else if (m === 'session/load') {
    handleLoadSession(msg).catch(e => log(`[ERR] session/load: ${e.message}`));
  } else if (m === 'session/prompt') {
    handlePrompt(msg).catch(e => log(`[ERR] session/prompt: ${e.message}`));
  } else if (m === 'session/cancel') {
    handleCancel(msg).catch(e => log(`[ERR] session/cancel: ${e.message}`));
  }
});

/* ───────── Message Handling ───────── */

async function handlePrompt(msg) {
  try {
    const params = msg.params || {};
    const sid = params.sessionId || currentSessionId || 'sess_fallback';
    const text = (params.prompt || []).map(b => b.text || '').join('').trim();

    if (!text) { sendResponse(msg.id, { stopReason: 'end_turn' }); return; }

    if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }

    await drainPendingNotifications();

    if (text.startsWith('/')) {
      await handleCommand(sid, text, msg.id);
      return;
    }

    const targetId = currentSessionId;
    if (!targetId) {
      reply(sid, '⚠️ 没有选中的会话。使用 /list 查看，/switch N 选择');
      sendResponse(msg.id, { stopReason: 'end_turn' });
      return;
    }

    reply(sid, '⏳ 思考中...');
    sendResponse(msg.id, { stopReason: 'end_turn' });
    forwardToAIAsync(sid, targetId, text).catch(e => log(`[ERR] fwd: ${e.message}`));
  } catch (err) {
    log(`[ERR] handlePrompt: ${err.message}`);
    sendResponse(msg.id, { stopReason: 'error' });
  }
}

async function handleCommand(sid, text, msgId) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');

  switch (cmd) {
    case '/list': case '/l': case '/sessions':
      return listSessions(sid, msgId);
    case '/switch': case '/s':
      return switchSession(sid, arg, msgId);
    case '/mute': case '/m':
      return toggleMute(sid, msgId);
    case '/notify': case '/n':
      return showNotifyStatus(sid, msgId);
    case '/cancel': case '/c':
      return cancelCurrent(sid, msgId);
    case '/status': case '/st':
      return showTaskStatus(sid, msgId);
    case '/plan': case '/pl':
      return switchAgent(sid, 'plan', msgId);
    case '/build': case '/bu':
      return switchAgent(sid, 'build', msgId);
    case '/new': case '/create':
      return newSession(sid, arg, msgId);
    case '/workspace': case '/ws':
      return handleWorkspace(sid, arg, msgId);
    case '/plist': case '/pending':
      return listPermissions(sid, msgId);

    case '/testnotify':
      return testNotify(sid, msgId);
    case '/help': case '/h':
      return showHelp(sid, msgId);
    default:
      reply(sid, `⚠️ 未知命令: ${cmd}\n/help 查看可用命令`);
      sendResponse(msgId, { stopReason: 'end_turn' });
      return;
  }
}

/* ───────── Command Handlers ───────── */

async function listSessions(sid, msgId) {
  try {
    const sessions = await apiFetch('/session');
    if (!Array.isArray(sessions) || sessions.length === 0) {
      reply(sid, '📋 暂无会话');
      sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
    const sorted = sessions.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
    const maxShow = 20;
    const show = sorted.slice(0, maxShow);

    const statusMap = await apiFetch('/session/status').catch(() => ({}));
    const busyIds = new Set(
      Object.entries(statusMap)
        .filter(([, s]) => s.type === 'busy')
        .map(([id]) => id)
    );

    const lines = [`📋 会话 (${sessions.length}个)`];
    lines.push('─'.repeat(16));
    show.forEach((s, i) => {
      const active = s.id === currentSessionId ? '◀' : '  ';
      const busy = busyIds.has(s.id) ? '▶' : ' ';
      const name = s.title || '(未命名)';
      const model = s.model?.id?.split('/').pop() || '';
      lines.push(`${String(i + 1).padStart(2)} ${active}${busy} ${name}${model ? ' [' + model + ']' : ''}`);
    });
    if (sessions.length > maxShow) lines.push(`...及另外 ${sessions.length - maxShow} 个`);
    lines.push('─'.repeat(16));
    lines.push('回复编号选会话，/switch <编号|ID> 切换');
    reply(sid, lines.join('\n'));
  } catch (err) {
    reply(sid, `⚠️ 获取列表失败: ${err.message}`);
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function switchSession(sid, arg, msgId) {
  if (!arg) {
    reply(sid, '用法: /switch <编号|会话ID>\n先用 /list 查看会话列表');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  // Try as number index first
  if (/^\d+$/.test(arg)) {
    try {
      const sessions = await apiFetch('/session');
      if (!Array.isArray(sessions)) throw new Error('获取会话列表失败');
      const sorted = sessions.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
      const idx = parseInt(arg, 10) - 1;
      if (idx < 0 || idx >= sorted.length) {
        reply(sid, `⚠️ 编号 ${arg} 超出范围 (1-${sorted.length})`);
        sendResponse(msgId, { stopReason: 'end_turn' });
        return;
      }
      const target = sorted[idx];
      currentSessionId = target.id;
      saveSession(target.id);
      reply(sid, `✅ 已切换到「${target.title || '(未命名)'}」`);
    } catch (err) {
      reply(sid, `⚠️ 切换失败: ${err.message}`);
    }
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  // Try as session ID directly
  try {
    const data = await apiFetch(`/session/${arg}`);
    currentSessionId = data.id || arg;
    saveSession(currentSessionId);
    reply(sid, `✅ 已切换到「${data.title || '(未命名)'}」`);
  } catch {
    reply(sid, '⚠️ 未找到该会话，请用 /list 查看可用会话');
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

function toggleMute(sid, msgId) {
  const sub = getOrCreateSubscriber(sid);
  sub.muted = !sub.muted;
  saveSubscribers();
  reply(sid, sub.muted ? '🔕 通知已关闭' : '🔔 通知已开启');
  sendResponse(msgId, { stopReason: 'end_turn' });
}

function showNotifyStatus(sid, msgId) {
  const sub = getOrCreateSubscriber(sid);
  const lines = [
    '📡 通知设置',
    `├ 状态: ${sub.muted ? '🔕 已静音' : '🔔 已开启'}`,
    `├ 订阅用户: ${subscribers.length} 人`,
    `├ 当前会话: ${currentSessionId ? currentSessionId.slice(0, 16) + '...' : '未选择'}`,
    `└ 活跃监控: ${sessionStates.size} 个`,
  ];
  reply(sid, lines.join('\n'));
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function cancelCurrent(sid, msgId) {
  const target = currentSessionId;
  if (!target) {
    reply(sid, '⚠️ 没有选中的会话');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  try {
    await fetch(`${SERVER}/session/${target}/abort`, {
      method: 'POST', headers: { Authorization: AUTH }, signal: AbortSignal.timeout(5000),
    });
    reply(sid, '⏹️ 已发送取消请求');
  } catch {
    reply(sid, '⚠️ 取消失败');
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function newSession(sid, title, msgId) {
  if (!title) {
    reply(sid, '用法: /new <会话名>\n示例: /new 修复登录bug');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  const dir = getWorkspaceDir();
  try {
    const data = await apiFetch(`/session?directory=${encodeURIComponent(dir)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), directory: dir }),
    });
    currentSessionId = data.id;
    saveSession(data.id);
    reply(sid, `✅ 已创建并切换到「${title.trim()}」`);
  } catch (err) {
    reply(sid, `⚠️ 创建失败: ${err.message}`);
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function switchAgent(sid, agent, msgId) {
  currentAgent = agent;
  const labels = { plan: '📋', build: '🔧' };
  reply(sid, `${labels[agent] || '✅'} 已切换到 ${agent} 模式`);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function listPermissions(sid, msgId) {
  if (pendingPermissions.size === 0) {
    reply(sid, '📋 当前没有待处理的权限请求');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  const entries = [...pendingPermissions.entries()];
  const lines = [`📋 待审批权限 (${entries.length}个)`, '─'.repeat(16)];
  entries.forEach(([rid, info], i) => {
    const ago = Math.round((Date.now() - info.ts) / 1000);
    lines.push(`${i + 1}. ${info.permission}`);
    if (info.patterns) lines.push(`   ${info.patterns.slice(0, 60)}`);
    lines.push(`   ${ago}s前`);
  });
  lines.push('─'.repeat(10));
  lines.push('请使用 Web UI (localhost:4096) 审批');
  reply(sid, lines.join('\n'));
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function handleWorkspace(sid, arg, msgId) {
  const list = loadWorkspaces();

  if (!arg) {
    const lines = ['📂 工作区', '─'.repeat(16)];
    list.forEach((w, i) => {
      const mark = w.path === currentWorkspace?.path ? ' ◀' : '';
      lines.push(`${i + 1}. ${w.name}${mark}`);
    });
    lines.push('─'.repeat(16));
    lines.push(`当前: ${currentWorkspace?.name}`);
    lines.push('/workspace <编号> 切换');
    reply(sid, lines.join('\n'));
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  const num = parseInt(arg, 10);
  if (isNaN(num) || num < 1 || num > list.length) {
    reply(sid, `⚠️ 请输入 1-${list.length} 之间的编号`);
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  currentWorkspace = list[num - 1];
  saveCurrentWorkspace();
  reply(sid, `✅ 已切换到工作区「${currentWorkspace.name}」\n${currentWorkspace.path}\n使用 /new <会话名> 在该工作区创建会话`);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function showTaskStatus(sid, msgId) {
  try {
    const statusMap = await apiFetch('/session/status');
    const lines = ['📊 任务状态', '─'.repeat(14)];
    let hasActive = false;
    for (const [id, st] of Object.entries(statusMap || {})) {
      if (st.type === 'busy') {
        hasActive = true;
        const info = await apiFetch(`/session/${id}`).catch(() => null);
        const name = info?.title || id.slice(0, 16);
        const isCurrent = id === currentSessionId ? ' ◀当前' : '';
        lines.push(`▶ ${name} — 运行中${isCurrent}`);
      }
    }
    if (!hasActive) lines.push('当前无运行中的任务');
    reply(sid, lines.join('\n'));
  } catch (err) {
    reply(sid, `⚠️ ${err.message}`);
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

function showHelp(sid, msgId) {
  const lines = [
    '🤖 微信远程编程助手',
    '─'.repeat(14),
    '/list (/l) 或 /sessions    查看会话列表',
    '/switch (/s) <编号|ID>    切换会话',
    '/new (/create) <会话名>   新建会话（当前工作区）并切换',
    '/plan (/pl)              切换到 plan 模式',
    '/build (/bu)             切换到 build 模式',
    '/workspace (/ws)          查看/切换工作区',
    '/status (/st)             查看任务运行状态',
    '/cancel (/c)              取消当前AI执行',
    '权限审批请使用 Web UI (localhost:4096)',
    '/mute (/m)                开关通知',
    '/notify (/n)              查看通知状态',
    '/help (/h)                显示此帮助',
    '/testnotify               发送测试通知（调试用）',
    '',
    '发送其他文字将转发给当前选中的AI会话',
  ];
  reply(sid, lines.join('\n'));
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function testNotify(sid, msgId) {
  log('[TEST] broadcasting test notification');
  broadcastNotification('🧪 这是一条测试通知\n如果看到这条消息，说明主动通知功能正常');
  // Force immediate flush (not waiting for 15s timer)
  clearTimeout(proactiveTimer);
  proactiveTimer = null;
  await drainPendingNotifications(true);
  log('[TEST] test notification sent');
  reply(sid, '✅ 已发送测试通知，请查看微信消息');
  sendResponse(msgId, { stopReason: 'end_turn' });
}

/* ───────── AI Prompt Forwarding ───────── */

async function forwardToAIAsync(sid, targetId, text) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const res = await fetch(`${SERVER}/session/${targetId}/message`, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text }], agent: currentAgent }),
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      reply(sid, `⚠️ 服务器错误 (${res.status}): ${errText.slice(0, 100)}`);
      await drainPendingNotifications();
      flushToWeChat();
      return;
    }

    const data = await res.json();
    await drainPendingNotifications();
    const formatted = formatReply(data);
    if (formatted) {
      reply(sid, formatted);
      flushToWeChat();
    }
  } catch (err) {
    const isCancel = err.name === 'AbortError';
    reply(sid, isCancel ? '⏰ 请求超时，请重试' : `❌ ${err.message}`);
    await drainPendingNotifications();
    flushToWeChat();
  }
}

function formatReply(data) {
  const parts = data?.parts || [];
  if (!parts.length) return '';

  let textParts = [];
  let toolCalls = [];
  let reasoningBuf = '';

  for (const p of parts) {
    if (p.type === 'text' && p.text) textParts.push(p.text);
    else if (p.type === 'reasoning' && p.text) reasoningBuf += p.text;
    else if (p.type === 'tool' && (p.tool || p.name)) {
      const t = p.tool || p;
      const status = t.state?.status === 'success' ? '✅' : (t.state?.status === 'error' || t.state?.status === 'failed') ? '❌' : '🔄';
      toolCalls.push({ name: t.tool || t.name || '未知', status });
    }
  }

  const blocks = [];
  if (reasoningBuf) {
    const short = reasoningBuf.length > 150 ? reasoningBuf.slice(0, 150) + '...' : reasoningBuf;
    blocks.push(`🤔 ${short}`);
  }
  if (toolCalls.length) {
    const tools = toolCalls.slice(-6).map(t => `${t.status} ${t.name}`).join('\n');
    blocks.push(`🔧\n${tools}`);
  }
  const mainText = textParts.join('\n').trim();
  if (mainText) {
    if (blocks.length) blocks.push('');
    blocks.push(mainText.length > 1500 ? mainText.slice(0, 1500) + '\n\n...（输出过长，已截断）' : mainText);
  }
  return blocks.join('\n');
}

/* ───────── ACP Handlers ───────── */

async function handleNewSession(msg) {
  if (currentSessionId) {
    sendResponse(msg.id, { sessionId: currentSessionId, configOptions: [], modes: null, models: null });
    return;
  }
  try {
    const res = await fetch(`${SERVER}/session`, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'WeChat' }),
    });
    const data = res.ok ? await res.json() : {};
    currentSessionId = data.id || ('sess_' + Date.now());
    saveSession(currentSessionId);
    sendResponse(msg.id, { sessionId: currentSessionId, configOptions: [], modes: null, models: null });
  } catch {
    const sid = 'sess_' + Date.now();
    sendResponse(msg.id, { sessionId: sid, configOptions: [], modes: null, models: null });
  }
}

async function handleListSessions(msg) {
  try {
    const res = await fetch(`${SERVER}/session`, { headers: { Authorization: AUTH } });
    const list = res.ok ? await res.json() : [];
    const sessions = (Array.isArray(list) ? list : []).map(s => ({
      sessionId: s.id, cwd: s.directory || '', title: s.title || '',
      updatedAt: s.time?.updated ? new Date(s.time.updated).toISOString() : undefined,
    }));
    sendResponse(msg.id, { sessions });
  } catch {
    sendResponse(msg.id, { sessions: [] });
  }
}

async function handleLoadSession(msg) {
  const sessionId = msg.params?.sessionId;
  if (!sessionId) { sendResponse(msg.id, { _meta: { error: 'sessionId required' } }); return; }
  try {
    const data = await apiFetch(`/session/${sessionId}`);
    currentSessionId = data.id || sessionId;
    saveSession(currentSessionId);
    sendResponse(msg.id, { sessionId: currentSessionId, cwd: data.directory || '', title: data.title || '',
      updatedAt: data.time?.updated ? new Date(data.time.updated).toISOString() : undefined });
  } catch (err) {
    sendResponse(msg.id, { _meta: { error: err.message } });
  }
}

async function handleCancel(msg) {
  const sid = msg.params?.sessionId || currentSessionId;
  if (sid) {
    try { await fetch(`${SERVER}/session/${sid}/abort`, { method: 'POST', headers: { Authorization: AUTH }, signal: AbortSignal.timeout(5000) }); } catch {}
  }
}

/* ───────── Workspace ───────── */

function loadWorkspaces() {
  try {
    if (existsSync(WORKSPACES_FILE)) {
      const data = JSON.parse(readFileSync(WORKSPACES_FILE, 'utf8'));
      if (Array.isArray(data) && data.length) return data;
    }
  } catch {}
  return [{ name: '主项目', path: WORK_DIR }];
}

function loadDefaultWorkspace() {
  const list = loadWorkspaces();
  try {
    if (existsSync(WORKSPACE_CURRENT_FILE)) {
      const saved = JSON.parse(readFileSync(WORKSPACE_CURRENT_FILE, 'utf8'));
      const match = list.find(w => w.path === saved.path);
      if (match) return match;
    }
  } catch {}
  return list[0];
}

function saveCurrentWorkspace() {
  try { writeFileSync(WORKSPACE_CURRENT_FILE, JSON.stringify({ path: currentWorkspace.path })); } catch {}
}

function getWorkspaceDir() {
  return currentWorkspace?.path || WORK_DIR;
}

/* ───────── Session Persistence ───────── */

function loadSession() {
  try {
    if (existsSync(SESSION_FILE)) {
      const saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
      if (saved.sessionId) return saved.sessionId;
    }
  } catch {}
  return null;
}
function saveSession(id) {
  try { writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: id })); } catch {}
}

/* ───────── Subscribers ───────── */

function loadSubscribers() {
  try { if (existsSync(SUBSCRIBERS_FILE)) subscribers = JSON.parse(readFileSync(SUBSCRIBERS_FILE, 'utf8')); } catch {}
  if (!Array.isArray(subscribers)) subscribers = [];
}
function saveSubscribers() {
  try { writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subscribers, null, 2)); } catch {}
}
function getOrCreateSubscriber(sid) {
  let s = subscribers.find(x => x.sid === sid);
  if (!s) { s = { sid, muted: false, lastActive: Date.now() }; subscribers.push(s); }
  return s;
}

/* ───────── I/O Helpers ───────── */

function reply(sid, text) {
  sendNotification('session/update', {
    sessionId: sid,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId: uuid() },
  });
}

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
  log(`→ response id=${id} ok`);
}

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(msg + '\n');
}

async function apiFetch(path, opts = {}) {
  const { headers: extraHeaders, ...rest } = opts;
  const res = await fetch(`${SERVER}${path}`, {
    headers: { Authorization: AUTH, ...extraHeaders },
    signal: AbortSignal.timeout(10000),
    ...rest,
  });
  if (!res.ok) {
    let errText;
    try { errText = await res.text(); } catch { errText = res.statusText; }
    throw new Error(`${res.status}: ${errText.slice(0, 200)}`);
  }
  if (opts.method === 'DELETE') return {};
  return res.json();
}

/* ═══════════════════════════════════════
   Notification System — SSE Event Monitor
   ═══════════════════════════════════════ */

let sessionNames = new Map();
let idleNotified = new Set();
let recentNotifications = new Map(); // text → timestamp, dedup within 30s

let proactiveTimer = null;

function broadcastNotification(text) {
  // Text-level dedup: skip if same text was sent within last 30s
  const now = Date.now();
  const lastSent = recentNotifications.get(text);
  if (lastSent && now - lastSent < 30000) {
    log(`[NOTIFY] skipped (dedup within 30s): ${text.slice(0, 60)}`);
    return;
  }
  recentNotifications.set(text, now);
  // Clean old entries periodically
  if (recentNotifications.size > 50) {
    for (const [t, ts] of recentNotifications) {
      if (now - ts > 60000) recentNotifications.delete(t);
    }
  }

  log(`[NOTIFY] ${text.slice(0, 100)}`);
  const targets = subscribers.filter(s => !s.muted);
  for (const t of targets) pendingNotifications.push({ sid: t.sid, text });
  // Schedule proactive flush if no user message arrives within 15s
  if (!proactiveTimer) {
    proactiveTimer = setTimeout(() => {
      proactiveTimer = null;
      drainPendingNotifications(true).catch(() => {});
    }, 15000);
  }
}

async function drainPendingNotifications(forceFlush) {
  if (draining || pendingNotifications.length === 0) return;
  draining = true;
  try {
    const batch = pendingNotifications.splice(0);
    log(`[DRAIN] flushing ${batch.length} pending notification(s)`);
    const grouped = new Map();
    for (const n of batch) {
      const existing = grouped.get(n.sid) || [];
      existing.push(n.text);
      grouped.set(n.sid, existing);
    }
    for (const [sid, texts] of grouped) {
      try { reply(sid, texts.join('\n')); } catch (e) { log(`[DRAIN] reply error for ${sid}: ${e.message}`); }
    }
    if (forceFlush) flushToWeChat();
  } catch (e) {
    log(`[DRAIN] error: ${e.message}`);
  } finally {
    draining = false;
  }
}

function flushToWeChat() {
  // Send a tool_call notification to trigger WeChatAcpClient.maybeFlushMessage()
  sendNotification('session/update', {
    sessionId: '',
    update: {
      sessionUpdate: 'tool_call',
      title: 'notification',
      toolCallId: uuid(),
      status: 'completed',
    },
  });
}

function updateSessionState(id, updates) {
  const existing = sessionStates.get(id) || {};
  const next = { ...existing, ...updates };
  sessionStates.set(id, next);
  return next;
}

function getSessionName(id) {
  return sessionNames.get(id) || id?.slice(0, 12) || '?';
}

async function idleNotification(props) {
  const sid = props.sessionID;
  if (!sid || idleNotified.has(sid)) return null;
  idleNotified.add(sid);
  await fetchSessionName(sid);
  const name = sessionNames.get(sid) || sid;
  return `✅ ${name} · 完成`;
}

// Map events to short, readable notifications. Return null to skip.
async function eventToNotification(type, props) {
  switch (type) {
    case 'session.error': {
      const err = props.error;
      if (!err) return '❌ 会话出错';
      const brief = err.data?.message || err.message || '未知错误';
      return `❌ ${err.name}\n${brief.slice(0, 100)}`;
    }
    case 'question.asked': {
      const q = props.question || '';
      const opts = props.options?.slice(0, 4).map((o, i) => `${i + 1}. ${o.label}`).join('\n') || '';
      let msg = `💬 需要你回答\n${q}`;
      if (opts) msg += `\n${opts}`;
      return msg;
    }
    case 'permission.asked': {
      const t = props.permission || '操作';
      const p = props.patterns?.[0] || props.metadata?.path || props.metadata?.file || props.metadata?.command || '';
      const rid = props.requestID;
      const sid = props.sessionID;
      if (rid) {
        pendingPermissions.set(rid, { sessionID: sid, permission: t, patterns: p, ts: Date.now() });
        setTimeout(() => pendingPermissions.delete(rid), 300_000);
      }
      return `🔑 需要权限: ${t}\n${p.slice(0, 80)}\n请使用 Web UI (localhost:4096) 审批`;
    }
    case 'session.idle': {
      return idleNotification(props);
    }
    case 'session.status': {
      const st = props.status;
      if (!st) return null;
      if (st.type === 'idle') {
        return idleNotification(props);
      }
      if (st.type === 'retry') {
        const sid = props.sessionID;
        const state = updateSessionState(sid, { retryCount: (sessionStates.get(sid)?.retryCount || 0) + 1 });
        if (state.retryCount >= 3) return `🔄 AI重试${state.retryCount}次未恢复`;
        return null;
      }
      if (st.type === 'busy') {
        idleNotified.delete(props.sessionID);
        updateSessionState(props.sessionID, { busySince: Date.now(), lastActivity: Date.now() });
        return null;
      }
      return null;
    }
    case 'message.part.delta':
    case 'message.part.updated':
      if (props.sessionID) updateSessionState(props.sessionID, { lastActivity: Date.now() });
      return null;
    default:
      return null;
  }
}

async function fetchSessionName(id) {
  if (!id || sessionNames.has(id)) return;
  try {
    const data = await apiFetch(`/session/${id}`);
    if (data.title) sessionNames.set(id, data.title);
  } catch {}
}

// ── SSE connection ──

async function connectSSE() {
  let retryDelay = 1000;
  const maxDelay = 30000;

  while (true) {
    try {
      log('[SSE] Connecting...');
      const eventUrl = `${SERVER}/global/event?directory=${encodeURIComponent(getWorkspaceDir())}`;
      const abortControl = new AbortController();
      const connTimer = setTimeout(() => abortControl.abort(), 15000);
      const response = await fetch(eventUrl, {
        headers: { Authorization: AUTH, 'x-opencode-directory': getWorkspaceDir() },
        signal: abortControl.signal,
      });
      clearTimeout(connTimer);
      if (!response.ok) throw new Error(`SSE ${response.status}`);
      if (!response.body) throw new Error('SSE body is null');
      retryDelay = 1000;
      log('[SSE] Connected');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let currentEvent = '';
      let currentData = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '') {
            if (currentData) {
              try {
                const parsed = JSON.parse(currentData);
                const payload = parsed.payload || parsed;
                const eventType = payload.type || currentEvent;
                const props = payload.properties || {};
                if (props.id) props.requestID ??= props.id;
                if (payload.id && !props.requestID) props.requestID ??= payload.id;
                log(`[SSE] event=${eventType} sessionID=${props.sessionID || '?'}`);
                const text = await eventToNotification(eventType, props);
                if (text) {
                  log(`[SSE] notification generated: ${text.slice(0, 80)}`);
                  broadcastNotification(text);
                }
              } catch (e) {
                log(`[SSE] Parse error: ${e.message}`);
              }
            }
            currentEvent = '';
            currentData = '';
          } else if (trimmed.startsWith('event:')) {
            currentEvent = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('data:')) {
            currentData += trimmed.slice(5).trim();
          }
        }
      }
      log('[SSE] Stream ended, reconnecting...');
    } catch (err) {
      log(`[SSE] Error: ${err.message}, retry in ${retryDelay}ms`);
    }

    await new Promise(r => setTimeout(r, retryDelay));
    retryDelay = Math.min(retryDelay * 2, maxDelay);
  }
}

// ── Watchdog: detect stuck sessions ──

function startWatchdog() {
  const STUCK_WARN_MS = 5 * 60 * 1000;
  const STUCK_ALERT_MS = 10 * 60 * 1000;

  setInterval(() => {
    try {
      const now = Date.now();
      for (const [id, state] of sessionStates.entries()) {
        if (state.busySince && state.lastActivity) {
          const busyDuration = now - state.busySince;
          const idleSinceActivity = now - state.lastActivity;
          fetchSessionName(id).catch(() => {});
          const name = getSessionName(id);

          if (busyDuration > STUCK_ALERT_MS && !state.stuckAlerted) {
            state.stuckAlerted = true;
            broadcastNotification(`🔴 卡死\n「${name}」已运行${Math.round(busyDuration / 60000)}分钟无响应`);
          } else if (busyDuration > STUCK_WARN_MS && idleSinceActivity > 60000 && !state.stuckWarned) {
            state.stuckWarned = true;
            broadcastNotification(`⏰ 可能卡住\n「${name}」已${Math.round(busyDuration / 60000)}分钟无活动`);
          }
        }

        if (state.retryCount >= 3 && !state.retryAlerted) {
          state.retryAlerted = true;
          broadcastNotification(`🔄 AI重试循环\n已连续重试${state.retryCount}次，请检查`);
        }
      }
      const staleCutoff = now - 30 * 60 * 1000;
      for (const [id, state] of sessionStates.entries()) {
        if (!state.busySince && state.lastActivity && state.lastActivity < staleCutoff) {
          sessionStates.delete(id);
          sessionNames.delete(id);
          idleNotified.delete(id);
        }
      }
    } catch (e) {
      log(`[WATCHDOG] error: ${e.message}`);
    }
  }, 30000);
}

// ── Startup ──

loadSubscribers();
connectSSE();
startWatchdog();
log('Bot started');
