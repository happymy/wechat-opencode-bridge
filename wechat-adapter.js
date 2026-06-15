import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const SERVER = process.env.OPENCODE_SERVER || 'http://localhost:4096';
const AUTH = 'Basic ' + Buffer.from(process.env.OPENCODE_AUTH || 'opencode:opencode').toString('base64');
const WORK_DIR = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = join(WORK_DIR, '.wechat-session.json');
const SUBSCRIBERS_FILE = join(WORK_DIR, '.wechat-subscribers.json');
const WORKSPACES_FILE = join(WORK_DIR, '.wechat-workspaces.json');
const WORKSPACE_CURRENT_FILE = join(WORK_DIR, '.wechat-workspace-current.json');
const SETTINGS_FILE = join(WORK_DIR, '.wechat-settings.json');

const rl = createInterface({ input: process.stdin });
let currentSessionId = loadSession();
let currentWorkspace = loadDefaultWorkspace();
let currentAgent = 'build';
let filterLevel = 'pad';
const FILTER_LEVELS = ['full', 'pad', 'phone'];
const FILTER_FILE = join(WORK_DIR, '.wechat-filter.json');
function loadFilterLevel() {
  try {
    if (existsSync(FILTER_FILE)) return JSON.parse(readFileSync(FILTER_FILE, 'utf8')).level || 'pad';
  } catch {}
  return 'pad';
}
function saveFilterLevel() { try { writeFileSync(FILTER_FILE, JSON.stringify({ level: filterLevel })); } catch {} }
function isFull() { return filterLevel === 'full'; }
function isPhone() { return filterLevel === 'phone'; }

filterLevel = loadFilterLevel();
let lineBuf = '';
let subscribers = [];
let sessionStates = new Map();
let pendingNotifications = [];
let pendingPermissions = new Map();
let pendingQuestions = null;
let draining = false;

// Response handling
let lastPromptSid = null;     // last wechat user who sent a prompt
let lastPromptSessionId = null; // last session prompted
let lastPromptText = '';      // last prompt text
let pendingReplyText = '';    // accumulated text parts for question API responses
let responseSent = false;     // true after final reply is sent (prevents double-reply)
let responseForSession = null; // session ID that the pending response is for
let workingTimer = null;      // "still working" notice timer
const WORKING_NOTICE_DELAY = 20000; // 20s before sending "still working"
const QUESTION_AUTO_CLEAR_MS = 86400000; // 24h safety net (server never auto-expires)
const MAX_ACCUMULATED_TEXT = 8000; // SSE 累积最大字符数，超限后截断
const NOTIFICATION_RATE_LIMIT_MS = 3000; // 同一用户连续通知最小间隔
const SESSION_MESSAGE_TIMEOUT = 300000; // 会话消息 POST 超时（5分钟）
let pendingQuestionQueue = []; // queue for question.asked events that arrive while one is pending

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
        mcpCapabilities: { http: false, sse: false },
        auth: {},
      },
      agentInfo: { name: 'opencode-wechat-bot', version: '4.0.0' },
      authMethods: [],
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
  } else if (msg.id != null) {
    sendResponse(msg.id, { _meta: { error: `unknown method: ${m}` } });
  }
});

/* ───────── Message Handling ───────── */

async function handlePrompt(msg) {
  try {
    const params = msg.params || {};
    const sid = params.sessionId || currentSessionId || 'sess_fallback';
    const text = (params.prompt || []).map(b => b.text || '').join('').trim();

    log(`[PROMPT] sid=${sid.slice(0,12)} text="${text.slice(0,60)}" msgId=${msg.id}`);

    if (!text) { log(`[PROMPT] empty text`); sendResponse(msg.id, { stopReason: 'end_turn' }); return; }

    getOrCreateSubscriber(sid);

    if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; log(`[PROMPT] cleared proactive timer`); }

    await drainPendingNotifications();

    // If AI is waiting for an answer, route non-command text as answer
    // Session check: only enforce if sessionID is known (some SSE events omit it)
    if (pendingQuestions && !text.startsWith('/') && (!pendingQuestions.sessionID || pendingQuestions.sessionID === currentSessionId)) {
      log(`[PROMPT] pending question, routing as answer`);
      await answerQuestion(sid, text, msg.id);
      return;
    }

    if (text.startsWith('/')) {
      log(`[PROMPT] routing to handleCommand`);
      await handleCommand(sid, text, msg.id);
      return;
    }

    const targetId = currentSessionId;
    if (!targetId) {
      reply(sid, '⚠️ 没有选中的会话。使用 /list 查看，/switch N 选择');
      sendResponse(msg.id, { stopReason: 'end_turn' });
      return;
    }

    // Record prompt source for streaming output routing
    lastPromptSid = sid;
    lastPromptSessionId = targetId;
    lastPromptText = text;
    pendingReplyText = '';
    responseSent = false;
    responseForSession = targetId;
    idleNotified.delete(targetId); // allow fresh idle events for this session
    armWorkingNotice(sid);

    reply(sid, '⏳ 思考中...');
    sendResponse(msg.id, { stopReason: 'end_turn' });
    forwardToAIAsync(sid, targetId, text).catch(e => log(`[ERR] fwd: ${e.message}`));
  } catch (err) {
    log(`[ERR] handlePrompt: ${err.message}`);
    sendResponse(msg.id, { stopReason: 'end_turn', _meta: { error: err.message } });
  }
}

async function handleCommand(sid, text, msgId) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');
  log(`[CMD] cmd=${cmd} arg="${arg.slice(0,40)}"`);

  switch (cmd) {
    case '/list': case '/l': case '/ls': case '/sessions':
      return listSessions(sid, arg, msgId);
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
    case '/nl': case '/new': case '/create':
      return newSession(sid, arg, msgId);
    case '/sw': case '/switch': case '/s':
      return switchSession(sid, arg, msgId);
    case '/level': case '/lvl':
      return handleFilterLevel(sid, arg, msgId);
    case '/f':
      return setFilterLevel(sid, 'full', msgId);
    case '/pd':
      return setFilterLevel(sid, 'pad', msgId);
    case '/ph':
      return setFilterLevel(sid, 'phone', msgId);
    case '/workspace': case '/ws':
      return handleWorkspace(sid, arg, msgId);
    case '/plist': case '/pending': case '/p':
      return listPermissions(sid, msgId);
    case '/allow': case '/a':
      return handlePermissionReply(sid, 'once', arg, msgId);
    case '/deny': case '/d':
      return handlePermissionReply(sid, 'reject', arg, msgId);
    case '/trust': case '/t':
      return handlePermissionReply(sid, 'always', arg, msgId);
    case '/answer': case '/ans':
      return answerQuestion(sid, arg, msgId);
    case '/skip': case '/pass': case '/ps':
      return skipQuestion(sid, arg, msgId);
    case '/qlist': case '/ql': case '/questions':
      return listQuestions(sid, msgId);
    case '/qshow': case '/qc': case '/qcurrent':
      return listCurrentQuestion(sid, msgId);
    case '/qs': case '/qsel': case '/qselect':
      return selectQuestion(sid, arg, msgId);
    case '/autoclean': case '/ac':
      return handleAutoClean(sid, arg, msgId);
    case '/sd':
      return handleSyncDir(sid, msgId);
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

async function getWorkspaceSessions() {
  const dir = getWorkspaceDir();
  const candidates = [dir];
  for (const sub of ['plan', 'build', 'debug']) {
    const subDir = join(dir, sub);
    if (!candidates.some(c => c.toLowerCase() === subDir.toLowerCase())) candidates.push(subDir);
  }
  for (const d of candidates) {
    const qs = new URLSearchParams({ directory: d, limit: '100' }).toString();
    const res = await apiFetch(`/api/session?${qs}`).catch(() => null);
    if (res?.data && Array.isArray(res.data) && res.data.length > 0) {
      return res.data;
    }
  }
  const fallback = await apiFetch('/session').catch(() => null);
  if (Array.isArray(fallback)) {
    const dirLower = dir.toLowerCase();
    return fallback.filter(s => s.directory && s.directory.toLowerCase().startsWith(dirLower));
  }
  return [];
}

async function listSessions(sid, arg, msgId) {
  try {
    let sessions;
    const allMatch = arg?.match(/^all\s*(\d+)?$/i);
    const isAll = !!allMatch;
    const allLimit = allMatch?.[1] ? parseInt(allMatch[1], 10) : 50;
    if (isAll) {
      const raw = await apiFetch('/session').catch(() => null);
      sessions = Array.isArray(raw) ? raw : [];
    } else {
      sessions = await getWorkspaceSessions();
      if (!Array.isArray(sessions)) sessions = [];
    }

    let currentInList = sessions.some(s => s.id === currentSessionId);
    if (!currentInList && currentSessionId) {
      try {
        const cur = await apiFetch(`/session/${encodeURIComponent(currentSessionId)}`).catch(() => null);
        if (cur && cur.id) {
          if (!sessions.some(s => s.id === cur.id)) {
            sessions.unshift(cur);
          }
          currentInList = true;
        }
      } catch {}
    }

    if (sessions.length === 0) {
      reply(sid, '📋 暂无会话');
      sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
    const sorted = [...sessions].sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
    const maxShow = isAll ? allLimit : 20;
    const show = sorted.slice(0, maxShow);

    const statusMap = await apiFetch('/session/status').catch(() => ({}));
    const busyIds = new Set(
      Object.entries(statusMap)
        .filter(([, s]) => s.type === 'busy')
        .map(([id]) => id)
    );

    const wsDir = getWorkspaceDir();
    const lines = [`📋 会话 (${sessions.length}个)`];
    lines.push('─'.repeat(16));
    show.forEach((s, i) => {
      const active = s.id === currentSessionId ? '◀' : '  ';
      const busy = busyIds.has(s.id) ? '▶' : ' ';
      const name = s.title || '(未命名)';
      const model = s.model?.id?.split('/').pop() || '';
      const marker = (s.directory && normalizeDir(s.directory) !== normalizeDir(wsDir)) ? ' ⚡' : '';
      lines.push(`${String(i + 1).padStart(2)} ${active}${busy} ${name}${model ? ' [' + model + ']' : ''}${marker}`);
    });
    if (sessions.length > maxShow) lines.push(`...及另外 ${sessions.length - maxShow} 个`);
    if (!currentInList && currentSessionId) {
      lines.push('─'.repeat(16));
      lines.push('⚠️ 当前会话不在本工作区，编号切换不可用');
    }
    lines.push('─'.repeat(16));
    lines.push(isAll ? '/switch <编号|ID> 切换  |  /l 查看本工作区' : '/l all [+数字]  返回全部会话前N条');
    reply(sid, lines.join('\n'));
  } catch (err) {
    reply(sid, `⚠️ 获取列表失败: ${err.message}`);
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function switchSession(sid, arg, msgId) {
  disarmWorkingNotice();
  pendingReplyText = '';
  responseSent = true;
  responseForSession = null;
  lastPromptSessionId = null;
  lastPromptSid = null;
  if (!arg) {
    reply(sid, '用法: /switch <编号|会话ID>\n先用 /list 查看会话列表');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  // Try as number index first
  if (/^\d+$/.test(arg)) {
    try {
      const sessions = await getWorkspaceSessions();
      if (!Array.isArray(sessions)) throw new Error('获取会话列表失败');
      const sorted = [...sessions].sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
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
    const data = await apiFetch(`/session/${encodeURIComponent(arg)}`);
    currentSessionId = data.id || arg;
    saveSession(currentSessionId);
    reply(sid, `✅ 已切换到「${data.title || '(未命名)'}」`);
  } catch {
    reply(sid, '⚠️ 未找到该会话，请用 /list 查看可用会话');
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

function toggleMute(sid, msgId) {
  try {
    const sub = getOrCreateSubscriber(sid);
    sub.muted = !sub.muted;
    saveSubscribers();
    reply(sid, sub.muted ? '🔕 通知已关闭' : '🔔 通知已开启');
  } catch (e) {
    log(`[MUTE] error: ${e.message}`);
    reply(sid, '⚠️ 操作失败');
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

function showNotifyStatus(sid, msgId) {
  try {
    const sub = getOrCreateSubscriber(sid);
    const lines = [
      '📡 通知设置',
      `├ 状态: ${sub.muted ? '🔕 已静音' : '🔔 已开启'}`,
      `├ 订阅用户: ${subscribers.length} 人`,
      `├ 当前会话: ${currentSessionId ? currentSessionId.slice(0, 16) + '...' : '未选择'}`,
      `└ 活跃监控: ${sessionStates.size} 个`,
    ];
    reply(sid, lines.join('\n'));
  } catch (e) {
    log(`[NOTIFY] error: ${e.message}`);
    reply(sid, '⚠️ 获取通知状态失败');
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function cancelCurrent(sid, msgId) {
  disarmWorkingNotice();
  pendingReplyText = '';
  responseSent = true;
  responseForSession = null;
  lastPromptSessionId = null;
  lastPromptSid = null;
  const target = currentSessionId;
  if (!target) {
    reply(sid, '⚠️ 没有选中的会话');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  try {
    await fetch(`${SERVER}/session/${encodeURIComponent(target)}/abort`, {
      method: 'POST', headers: { Authorization: AUTH }, signal: AbortSignal.timeout(5000),
    });
    reply(sid, '⏹️ 已发送取消请求');
  } catch {
    reply(sid, '⚠️ 取消失败');
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function newSession(sid, title, msgId) {
  disarmWorkingNotice();
  pendingReplyText = '';
  responseSent = true;
  responseForSession = null;
  lastPromptSessionId = null;
  lastPromptSid = null;
  if (!title) {
    reply(sid, '用法: /new <会话名>\n示例: /new 修复登录bug');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  try {
    const dir = getWorkspaceDir();
    const data = await apiFetch('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), directory: dir }),
    });
    currentSessionId = (data.id || 'sess_' + Date.now());
    saveSession(currentSessionId);
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

async function handleFilterLevel(sid, arg, msgId) {
  if (!arg) {
    const lines = ['🔍 信息过滤级别'];
    lines.push(`当前: ${levelLabel(filterLevel)}`);
    lines.push('─'.repeat(14));
    for (const lv of FILTER_LEVELS) {
      const mark = lv === filterLevel ? ' ◀' : '';
      lines.push(`${levelIcon(lv)} ${lv.toUpperCase()} — ${levelDesc(lv)}${mark}`);
    }
    lines.push('─'.repeat(14));
    lines.push('/f (FULL) 全部显示  |  /pd (PAD) 摘要显示  |  /ph (PHONE) 极简显示');
    reply(sid, lines.join('\n'));
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  const level = arg.trim().toLowerCase();
  if (!FILTER_LEVELS.includes(level)) {
    reply(sid, `⚠️ 无效级别: ${level}，可选: ${FILTER_LEVELS.join(', ')}`);
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  await setFilterLevel(sid, level, msgId);
}

async function setFilterLevel(sid, level, msgId) {
  filterLevel = level;
  saveFilterLevel();
  reply(sid, `${levelIcon(level)} 已切换到 ${level.toUpperCase()} 模式\n${levelDesc(level)}`);
  if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
}

function levelIcon(lv) {
  return { full: '📡', pad: '📱', phone: '📟' }[lv] || '🔍';
}
function levelDesc(lv) {
  return {
    full: '显示所有信息（工具调用、文件差异等全部转发）',
    pad: '摘要显示，隐藏工具输出和文件细节',
    phone: '极简模式，仅显示 AI 文本回复和错误',
  }[lv] || '';
}
function levelLabel(lv) {
  return { full: '📡 FULL 完整模式', pad: '📱 PAD 标准模式', phone: '📟 PHONE 极简模式' }[lv] || lv;
}

function summarizeText(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n…（共${text.length}字符，截断显示）`;
}

async function listPermissions(sid, msgId) {
  await syncPermissionsFromServer();
  if (pendingPermissions.size === 0) {
    reply(sid, '📋 当前没有待处理的权限请求');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  const entries = [...pendingPermissions.entries()];
  // Fetch all session names first
  const sesIds = [...new Set(entries.map(([,info]) => info.sessionID).filter(Boolean))];
  await Promise.all(sesIds.map(fetchSessionName));
  const lines = [`📋 待审批权限 (${entries.length}个)`];
  entries.forEach(([rid, info], i) => {
    const ago = Math.round((Date.now() - info.ts) / 1000);
    const sesLabel = info.sessionID ? `[${getSessionName(info.sessionID)}]` : '';
    const pathInfo = info.patterns ? `\n${info.patterns.slice(0, 80)}` : '';
    lines.push(`#${i+1}${sesLabel} ${info.permission}${pathInfo}`);
    lines.push(`${rid.slice(0,16)}... ${ago}秒前`);
  });
  lines.push('');
  lines.push('/allow (/a) 批准 | /deny (/d) 拒绝 | /trust (/t) 信任 | +<编号>');
  reply(sid, lines.join('\n'));
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function handlePermissionReply(sid, action, arg, msgId) {
  log(`[PERM] handlePermissionReply action=${action} arg=${arg || '(auto)'} sid=${sid.slice(0,12)} pending=${pendingPermissions.size}`);
  if (pendingPermissions.size === 0) {
    log(`[PERM] no pending permissions, aborting`);
    reply(sid, '📋 当前没有待处理的权限请求');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  let targetRid;
  if (!arg) {
    const entries = [...pendingPermissions.entries()];
    entries.sort((a, b) => b[1].ts - a[1].ts);
    targetRid = entries[0][0];
    log(`[PERM] auto-select rid=${targetRid.slice(0,16)}... (latest of ${entries.length})`);
  } else if (/^\d+$/.test(arg)) {
    const entries = [...pendingPermissions.entries()];
    const idx = parseInt(arg, 10) - 1;
    log(`[PERM] index-select idx=${idx} total=${entries.length}`);
    if (idx < 0 || idx >= entries.length) {
      reply(sid, `⚠️ 编号 ${arg} 超出范围 (1-${entries.length})`);
      sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
    targetRid = entries[idx][0];
  } else {
    targetRid = arg;
    log(`[PERM] direct rid=${targetRid.slice(0,16)}...`);
  }

  log(`[PERM] targetRid=${targetRid.slice(0,16)}... has=${pendingPermissions.has(targetRid)}`);
  if (!pendingPermissions.has(targetRid)) {
    log(`[PERM] targetRid not in pendingPermissions`);
    reply(sid, '⚠️ 未找到该权限请求，可能已过期或已通过其他端处理');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  try {
    log(`[PERM] sending reply: action=${action} rid=${targetRid.slice(0,16)}...`);
    const info = pendingPermissions.get(targetRid);
    const permSid = info?.sessionID;
    if (!permSid) {
      throw new Error('未知会话，无法提交权限回复');
    }
    await apiFetch(`/api/session/${encodeURIComponent(permSid)}/permission/${encodeURIComponent(targetRid)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: action, message: `via wechat-adapter (sid=${sid.slice(0,12)})` }),
    });
    const labels = { once: '✅ 已批准', always: '✅ 已信任', reject: '❌ 已拒绝' };
    const msg = `${labels[action]}: ${info?.permission || '权限请求'}`;
    log(`[PERM] reply success: ${msg}`);
    reply(sid, msg);
    pendingPermissions.delete(targetRid);
    log(`[PERM] deleted from pendingPermissions, remaining=${pendingPermissions.size}`);
  } catch (err) {
    log(`[PERM] reply FAILED: ${err.message}`);
    reply(sid, `⚠️ 操作失败: ${err.message}`);
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function syncPermissionsFromServer() {
  log(`[SYNC] start pendingPermissions.size=${pendingPermissions.size}`);
  try {
    const list = await apiFetch(`/api/permission/request?location[directory]=${encodeURIComponent(getWorkspaceDir())}`);
    log(`[SYNC] server returned ${Array.isArray(list) ? list.length + ' items' : typeof list}`);
    if (!Array.isArray(list)) { log(`[SYNC] not an array, skipping`); return; }
    const serverIds = new Set(list.map(r => r.id));
    log(`[SYNC] server IDs: [${[...serverIds].map(i=>i.slice(0,12)).join(', ')}]`);
    const before = pendingPermissions.size;
    for (const [rid] of pendingPermissions) {
      if (!serverIds.has(rid)) {
        log(`[SYNC] removing local rid=${rid.slice(0,16)}... (not on server)`);
        pendingPermissions.delete(rid);
      }
    }
    log(`[SYNC] done: ${before} -> ${pendingPermissions.size}`);
  } catch (e) {
    log(`[SYNC] fetch failed: ${e.message}`);
  }
}

async function syncPendingFromServer() {
  const dir = getWorkspaceDir();
  try {
    const permList = await apiFetch(`/api/permission/request?location[directory]=${encodeURIComponent(dir)}`);
    const serverPermIds = new Set((Array.isArray(permList) ? permList : []).map(r => r.id));
    for (const [rid] of pendingPermissions) {
      if (!serverPermIds.has(rid)) {
        log(`[SYNC] removing local perm rid=${rid.slice(0,16)}... (not on server)`);
        pendingPermissions.delete(rid);
      }
    }
    log(`[SYNC] perm synced: ${pendingPermissions.size} remaining`);
  } catch (e) {
    log(`[SYNC] perm sync failed: ${e.message}`);
  }
  try {
    const allQuestions = getAllQuestions();
    if (allQuestions.length === 0) return;
    const seen = new Set();
    for (const q of allQuestions) {
      const qsid = q.sessionID;
      if (!qsid || seen.has(qsid)) continue;
      seen.add(qsid);
      try {
        const sessQs = await apiFetch(`/api/session/${encodeURIComponent(qsid)}/question`);
        const validIds = new Set((sessQs?.data || []).map(r => r.id));
        for (const q2 of allQuestions) {
          if (q2.sessionID !== qsid) continue;
          if (q2.requestID && !validIds.has(q2.requestID)) {
            log(`[SYNC] removing local question rid=${q2.requestID.slice(0,16)}... (not on server)`);
            if (pendingQuestions?.requestID === q2.requestID) {
              pendingQuestions = null;
            } else {
              const qIdx = pendingQuestionQueue.findIndex(q => q.requestID === q2.requestID);
              if (qIdx >= 0) pendingQuestionQueue.splice(qIdx, 1);
            }
          }
        }
      } catch (e) {
        log(`[SYNC] session ${qsid.slice(0,12)} question sync failed: ${e.message}`);
      }
    }
    log(`[SYNC] questions synced: ${getAllQuestions().length} remaining`);
  } catch (e) {
    log(`[SYNC] question sync failed: ${e.message}`);
  }
}

async function handleWorkspace(sid, arg, msgId) {
  const list = loadWorkspaces();

  if (!arg) {
    const lines = ['📂 工作区'];
    list.forEach((w, i) => {
      const mark = wsPathEqual(w.path, currentWorkspace?.path) ? ' ◀' : '';
      lines.push(`#${i + 1} ${w.name}${mark} | ${w.path}`);
    });
    lines.push('');
    lines.push('/ws <编号>  切换');
    lines.push('/ws add <路径> [名称]  添加');
    lines.push('/ws del <编号>  删除');
    reply(sid, lines.join('\n'));
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  const addMatch = arg.match(/^add\s+(.+?)(?:\s+(\S+))?$/i);
  if (addMatch) {
    let dirPath = addMatch[1].trim();
    let name = addMatch[2]?.trim() || basename(dirPath);
    if (!dirPath || /[\x00-\x1f]/.test(dirPath)) {
      reply(sid, '⚠️ 路径无效（包含非法字符）');
      sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
    try { dirPath = resolve(dirPath); } catch { /* keep original if resolution fails */ }
    if (list.some(w => wsPathEqual(w.path, dirPath))) {
      reply(sid, `⚠️ 工作区已存在: ${name} (${dirPath})`);
      sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
    list.push({ name, path: dirPath });
    saveWorkspaces(list);
    reply(sid, `✅ 已添加工作区「${name}」\n${dirPath}`);
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  const delMatch = arg.match(/^del(?:ete)?\s+(\d+)$/i);
  if (delMatch) {
    const idx = parseInt(delMatch[1], 10) - 1;
    if (idx < 0 || idx >= list.length) {
      reply(sid, `⚠️ 编号 ${delMatch[1]} 超出范围 (1-${list.length})`);
      sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
    const removed = list.splice(idx, 1)[0];
    saveWorkspaces(list);
    if (wsPathEqual(currentWorkspace?.path, removed.path)) {
      currentWorkspace = list[0] || { name: '主项目', path: WORK_DIR };
      saveCurrentWorkspace();
    }
    reply(sid, `🗑️ 已删除工作区「${removed.name}」`);
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  const num = parseInt(arg, 10);
  if (isNaN(num) || num < 1 || num > list.length) {
    reply(sid, `⚠️ 请输入 1-${list.length} 之间的编号，或使用 /ws add / /ws del`);
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  disarmWorkingNotice();
  pendingReplyText = '';
  responseSent = true;
  responseForSession = null;
  lastPromptSessionId = null;
  lastPromptSid = null;
  currentWorkspace = list[num - 1];
  saveCurrentWorkspace();
  restartSSE();
  reply(sid, `✅ 已切换到工作区「${currentWorkspace.name}」\n${currentWorkspace.path}\n使用 /new <会话名> 在该工作区创建会话`);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

function discoverWorkspacesViaDb() {
  try {
    const out = execSync(
      'opencode db "SELECT id, worktree, sandboxes FROM project WHERE id != \'global\'" --format json',
      { encoding: 'utf8', timeout: 15000 }
    );
    const projects = JSON.parse(out.trim());
    if (!Array.isArray(projects)) return [];
    const dirs = new Set();
    for (const p of projects) {
      if (p.worktree && p.worktree !== '/') {
        dirs.add(p.worktree.replace(/\//g, '\\'));
      }
      if (p.sandboxes) {
        try {
          const boxes = JSON.parse(p.sandboxes);
          if (Array.isArray(boxes)) {
            for (const s of boxes) {
              if (s) dirs.add(s.replace(/\//g, '\\'));
            }
          }
        } catch (e) { log(`[SD] parse sandboxes JSON failed: ${e.message}`); }
      }
    }
    return [...dirs];
  } catch (err) {
    log(`[SD] db query failed: ${err.message}`);
    return [];
  }
}

async function handleSyncDir(sid, msgId) {
  try {
    const existing = loadWorkspaces();
    const existingPaths = new Set(existing.map(w => w.path.toLowerCase()));
    const added = [];
    const skipped = [];

    function isExisting(p) { return existingPaths.has(p.toLowerCase()); }
    function markExisting(p) { existingPaths.add(p.toLowerCase()); }

    const dbDirs = discoverWorkspacesViaDb();
    if (dbDirs.length > 0) {
      for (const dirPath of dbDirs) {
        if (isExisting(dirPath)) {
          skipped.push({ name: makeWsName(dirPath, existing), path: dirPath });
          continue;
        }
        const name = makeWsName(dirPath, existing);
        existing.push({ name, path: dirPath });
        added.push({ name, path: dirPath });
        markExisting(dirPath);
      }
    } else {
      log('[SD] db returned no directories, trying HTTP API fallback...');
      const projects = await apiFetch('/project').catch(() => null);
      if (Array.isArray(projects) && projects.length > 0) {
        for (const p of projects) {
          try {
            const dirs = await apiFetch(`/project/${encodeURIComponent(p.id)}/directories`);
            if (!Array.isArray(dirs)) continue;
            for (const d of dirs) {
              const dirPath = d.directory;
              if (!dirPath) continue;
              if (isExisting(dirPath)) {
                skipped.push({ name: basename(dirPath), path: dirPath });
                continue;
              }
              const name = makeWsName(dirPath, existing);
              existing.push({ name, path: dirPath });
              added.push({ name, path: dirPath });
              markExisting(dirPath);
            }
          } catch {
            log(`[SD] skip project ${p.id?.slice(0, 16)}: directories endpoint failed`);
          }
        }
      }

      if (added.length === 0) {
        log('[SD] project API yielded no directories, trying session fallback...');
        const sessions = await apiFetch('/session').catch(() => null);
        if (Array.isArray(sessions)) {
          const dirs = [...new Set(sessions.map(s => s.directory).filter(Boolean))];
          for (const dirPath of dirs) {
            if (isExisting(dirPath)) {
              skipped.push({ name: basename(dirPath), path: dirPath });
              continue;
            }
            const name = makeWsName(dirPath, existing);
            existing.push({ name, path: dirPath });
            added.push({ name, path: dirPath });
            markExisting(dirPath);
          }
        }
      }
    }

    if (added.length === 0 && skipped.length === 0) {
      reply(sid, '⚠️ 未能获取到工作区信息，请先确认 OpenCode 已打开项目');
      sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
    saveWorkspaces(existing);
    const lines = ['📂 工作区同步完成'];
    lines.push(`├ 新增: ${added.length} 个`);
    if (added.length > 0) lines.push(`├ ${added.map(a => a.name).join('、')}`);
    if (skipped.length > 0) lines.push(`├ 跳过: ${skipped.map(s => s.name).join('、')}`);
    lines.push(`└ 总计: ${existing.length} 个工作区`);
    reply(sid, lines.join('\n'));
    sendResponse(msgId, { stopReason: 'end_turn' });
    } catch (err) {
    reply(sid, `⚠️ 同步失败: ${err.message}`);
    sendResponse(msgId, { stopReason: 'end_turn' });
  }
}

function makeWsName(dirPath, existing) {
  let name = basename(dirPath);
  if (existing.some(w => w.name === name)) {
    const parts = dirPath.replace(/[\\/]+/g, '/').replace(/\/$/, '').split('/');
    name = parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : name;
  }
  return name;
}

async function showTaskStatus(sid, msgId) {
  try {
    const statusMap = await apiFetch('/session/status');
    const lines = ['📊 任务状态', '─'.repeat(14)];
    let hasActive = false;
    for (const [id, st] of Object.entries(statusMap || {})) {
      if (st.type === 'busy') {
        hasActive = true;
        const info = await apiFetch(`/session/${encodeURIComponent(id)}`).catch(() => null);
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
    '─'.repeat(20),
    '── 会话管理 ──',
    '/list (/l, /ls, /sessions)    查看会话列表；/l all [+数字] 返回全部会话前N条',
    '/switch (/s, /sw) <编号|ID>   切换会话',
    '/new (/nl, /create) <会话名>  新建会话并切换（当前工作区）',
    '',
    '── 模式切换 ──',
    '/plan (/pl)              切换到 plan 模式',
    '/build (/bu)             切换到 build 模式',
    '',
    '── 信息过滤 ──',
    `/level (/lvl) [级别]     查看/设置过滤级别 (当前: ${filterLevel.toUpperCase()})`,
    '/f                       切换到 FULL 模式（全部显示）',
    '/pd                      切换到 PAD 模式（摘要显示）',
    '/ph                      切换到 PHONE 模式（极简显示）',
    '',
    '── 问题回答（通知中直接回复也可）──',
    '/answer (/ans) [编号] <内容>  回答AI提问，默认第1题',
    '/skip (/pass, /ps) [编号]     跳过指定问题（默认当前）',
    '/qlist (/ql, /questions)      查看所有待回答问题',
    '/qshow (/qc, /qcurrent)       显示当前问题详情',
    '/qselect (/qs, /qsel) <编号>  选中指定问题为当前',
    '',
    '── 权限审批（通知中直接回复也可）──',
    '/allow (/a) [编号|ID]  批准权限请求（默认最新）',
    '/deny (/d) [编号|ID]   拒绝权限请求',
    '/trust (/t) [编号|ID]  信任权限（不再询问）',
    '/plist (/p, /pending)  查看待审批权限列表',
    '',
    '── 工作区与任务 ──',
    '/workspace (/ws)        查看/切换/添加/删除工作区',
    '/sd                     从 DB 同步所有 OpenCode 项目工作区',
    '/status (/st)           查看任务运行状态',
    '/cancel (/c)            取消当前AI执行',
    '',
    '── 通知与系统 ──',
    '/mute (/m)              开关主动通知',
    '/notify (/n)            查看通知状态与订阅信息',
    '/autoclean (/ac) [天数] 设置不活跃订阅自动清理天数',
    '/testnotify             发送测试通知（调试用）',
    '/help (/h)              显示此帮助',
    '',
    '💡 通知消息中可直接回复答案或权限审批，无需输入命令',
    '💡 未识别的消息将转发给当前选中的 AI 会话',
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

/* ───────── Question/Answer Handling ───────── */

function getAllQuestions() {
  const all = [];
  if (pendingQuestions) all.push(pendingQuestions);
  for (const q of pendingQuestionQueue) all.push(q);
  return all;
}

async function listQuestions(sid, msgId) {
  const all = getAllQuestions();
  if (all.length === 0) {
    reply(sid, '📋 当前没有待回答问题');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  // Fetch session names for all questions
  for (const q of all) {
    if (q.sessionID) await fetchSessionName(q.sessionID);
  }
  const lines = [`📋 待回答问题（${all.length}个）`];
  lines.push('─'.repeat(20));
  all.forEach((q, idx) => {
    const num = idx + 1;
    const active = idx === 0 && pendingQuestions ? ' ◀当前' : '';
    const sesName = q.sessionID ? getSessionName(q.sessionID) : '?';
    const qi = q.questions?.[0];
    const qBrief = qi?.question?.slice(0, 40) || '(无描述)';
    lines.push(`${num}. [${sesName}]${active}`);
    lines.push(`   ${qBrief}`);
    if (qi?.options?.length) {
      lines.push('   ' + qi.options.slice(0, 6).map((o, j) => `${j+1}.${o.label}`).join(' '));
    }
    if (q.questions?.length > 1) {
      lines.push(`   （共${q.questions.length}小题）`);
    }
  });
  lines.push('─'.repeat(20));
  lines.push('/ans (/answer) [问题编号] <内容>  回答指定编号问题，为空则默认第1题');
  lines.push('/qshow (/qc, /qcurrent)      查看当前问题详情');
  lines.push('/qselect (/qs, /qsel) <编号>  选中指定问题为当前活跃');
  lines.push('/skip (/pass, /ps) [编号]     跳过指定问题');
  reply(sid, lines.join('\n'));
  sendResponse(msgId, { stopReason: 'end_turn' });
}

function formatQuestionBody(questions) {
  if (!questions?.length) return '';
  const multi = questions.length > 1;
  let body = '';
  if (multi) {
    questions.forEach((qItem, idx) => {
      const qText = qItem.question || '';
      body += `\n\n${idx+1}. ${qText}`;
      if (qItem.options?.length) {
        body += '\n' + qItem.options.slice(0, 6).map((o, j) => `   ${j+1}. ${o.label}`).join('\n');
      }
    });
    body += '\n\n多个答案用逗号分隔，如：1, 2';
  } else {
    const qi = questions[0];
    const q = qi.question || '';
    const opts = qi.options?.slice(0, 6).map((o, i) => `${i+1}. ${o.label}`).join('\n') || '';
    body += `\n${q}`;
    if (opts) body += `\n${opts}`;
    if (qi.isSecret) body += '\n🔒 答案将保密发送';
    body += '\n回复内容，或 /ans (/answer) <内容> 提交';
    if (opts) body += '，或发送编号选择';
  }
  body += '\n/skip (/pass, /ps) 跳过，/qlist (/ql, /questions) 查看全部，/qshow (/qc, /qcurrent) 查看详情，/qselect (/qs, /qsel) <编号> 切换';
  return body;
}

async function listCurrentQuestion(sid, msgId) {
  if (!pendingQuestions) {
    const queued = pendingQuestionQueue.length;
    if (queued > 0) {
      reply(sid, `📌 当前无活跃问题，排队中 ${queued} 题，/qlist (/ql, /questions) 查看，/qselect (/qs, /qsel) <编号> 切换`);
    } else {
      reply(sid, '📋 当前没有待回答问题');
    }
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  const qData = pendingQuestions;
  const questions = qData.questions || [];
  const qi = questions[0];
  if (!qi) { reply(sid, '💬 问题无详情'); sendResponse(msgId, { stopReason: 'end_turn' }); return; }
  await fetchSessionName(qData.sessionID);
  const sesLabel = qData.sessionID ? `[${getSessionName(qData.sessionID)}] ` : '';
  const multi = questions.length > 1;
  let msg = multi ? `💬 待回答（共${questions.length}题）` : `💬 需要你回答`;
  if (sesLabel) msg = sesLabel + msg;
  msg += formatQuestionBody(questions);
  reply(sid, msg);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function selectQuestion(sid, arg, msgId) {
  const all = getAllQuestions();
  if (all.length === 0) {
    reply(sid, '📋 当前没有待回答问题');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  const idx = parseInt(arg?.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= all.length) {
    reply(sid, `⚠️ 编号无效 (1-${all.length})`);
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  // Already current
  if (idx === 0 && pendingQuestions) {
    return listCurrentQuestion(sid, msgId);
  }
  const queueIdx = pendingQuestions ? idx - 1 : idx;
  const target = pendingQuestionQueue.splice(queueIdx, 1)[0];
  if (!target) {
    reply(sid, '⚠️ 该问题不存在');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  // Push current back to queue head
  if (pendingQuestions) {
    pendingQuestionQueue.unshift(pendingQuestions);
  }
  pendingQuestions = target;
  // Auto-follow the question's session for cross-session answers
  if (target.sessionID) currentSessionId = target.sessionID;
  // Reset auto-clear
  const ts = Date.now();
  target.askTimestamp = ts;
  setTimeout(() => {
    if (pendingQuestions?.askTimestamp === ts) { pendingQuestions = null; dequeueNextQuestion(); }
  },     QUESTION_AUTO_CLEAR_MS).unref?.();
  return listCurrentQuestion(sid, msgId);
}

async function answerQuestion(sid, answer, msgId) {
  const all = getAllQuestions();
  if (all.length === 0) {
    reply(sid, '⚠️ 当前没有待回答的问题');
    if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  // Parse "[N] <content>" — leading number means question index
  let qIdx = 0;
  let answerText = answer.trim();
  const idxMatch = answerText.match(/^(\d+)\s+(.+)$/);
  if (idxMatch) {
    qIdx = parseInt(idxMatch[1], 10) - 1;
    answerText = idxMatch[2].trim();
    if (qIdx < 0 || qIdx >= all.length) {
      reply(sid, `⚠️ 编号 ${idxMatch[1]} 超出范围 (1-${all.length})`);
      if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
  }

  // Get the target question data and promote it to current if needed
  let qData;
  if (pendingQuestions && qIdx === 0) {
    qData = pendingQuestions;
  } else {
    const qIdxInQueue = pendingQuestions ? qIdx - 1 : qIdx;
    qData = pendingQuestionQueue.splice(qIdxInQueue, 1)[0];
    if (!qData) {
      reply(sid, '⚠️ 该问题不存在或已被回答');
      if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
    // Move this question to current, push old current back to queue
    if (pendingQuestions) {
      pendingQuestionQueue.unshift(pendingQuestions);
    }
    pendingQuestions = qData;
    // Auto-follow the question's session for cross-session answers
    if (qData.sessionID) currentSessionId = qData.sessionID;
    // Reset auto-clear timer
    const ts = Date.now();
    qData.askTimestamp = ts;
    setTimeout(() => {
      if (pendingQuestions?.askTimestamp === ts) { pendingQuestions = null; dequeueNextQuestion(); }
    },     QUESTION_AUTO_CLEAR_MS).unref?.();
  }

  const targetId = currentSessionId;

  // If we have a requestID (question API), session check is optional — the API binds to the question's session
  if (!qData.requestID) {
    if (!targetId) {
      reply(sid, '⚠️ 没有选中的会话，无法提交答案');
      if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
      pendingQuestions = null;
      await dequeueNextQuestion();
      return;
    }
    if (qData.sessionID && qData.sessionID !== targetId) {
      reply(sid, `⚠️ 该问题属于会话「${getSessionName(qData.sessionID)}」，请用 /switch 切换到该会话后回答`);
      if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
  }

  const qi = qData.questions?.[0];
  const multi = qData.questions?.length > 1;

  if (!answerText) {
    reply(sid, '⚠️ 答案不能为空。请回复内容或用编号选择选项');
    if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }

  // Collect answers for all questions
  let answers = [];
  if (multi) {
    const parts = answerText.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < qData.questions.length; i++) {
      const q = qData.questions[i];
      let a = parts[i] || '';
      if (q?.options?.length > 0 && /^\d+$/.test(a)) {
        const idx = parseInt(a, 10) - 1;
        if (idx >= 0 && idx < q.options.length) a = q.options[idx].label;
      }
      answers.push(a);
    }
  } else {
    // Numeric option selection for single question
    if (qi?.options?.length > 0 && /^\d+$/.test(answerText)) {
      const idx = parseInt(answerText, 10) - 1;
      if (idx >= 0 && idx < qi.options.length) {
        answerText = qi.options[idx].label;
        log(`[ANSWER] selected option ${answer} -> "${answerText}"`);
      }
    }
    answers.push(answerText);
  }

  const combined = answers.join(', ');
  pendingQuestions = null;
  await dequeueNextQuestion();
  log(`[ANSWER] sid=${sid.slice(0,12)} answers=[${combined}]`);
  lastPromptSid = sid;
  lastPromptSessionId = qData.sessionID || targetId;
  lastPromptText = combined;
  disarmWorkingNotice();
  pendingReplyText = '';
  responseSent = false;
  responseForSession = qData.sessionID || targetId;
  armWorkingNotice(sid);
  reply(sid, `⏳ 已提交回答`);
  if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
  if (qData.requestID) {
    answerViaQuestionApi(sid, targetId, answers, qData.requestID).catch(e => log(`[ERR] answerAPI: ${e.message}`));
  } else {
    forwardToAIAsync(sid, targetId, combined).catch(e => log(`[ERR] answer: ${e.message}`));
  }
}

async function answerViaQuestionApi(sid, targetId, answers, requestID) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SESSION_MESSAGE_TIMEOUT);
    let res;
    try {
      res = await fetch(`${SERVER}/api/session/${encodeURIComponent(targetId)}/question/${encodeURIComponent(requestID)}/reply`, {
        method: 'POST',
        headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: answers.map(a => [a]) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      disarmWorkingNotice();
      responseSent = true;
      responseForSession = null;
      pendingReplyText = '';
      const errText = await res.text();
      reply(sid, `⚠️ 回答提交失败 (${res.status}): ${errText.slice(0, 100)}`);
      await drainPendingNotifications();
      flushToWeChat();
      return;
    }
    await res.text();
    log(`[ANSWER] reply sent via question API, waiting for SSE response...`);
  } catch (err) {
    disarmWorkingNotice();
    responseSent = true;
    responseForSession = null;
    pendingReplyText = '';
    reply(sid, `❌ 回答提交失败: ${err.message}`);
    await drainPendingNotifications();
    flushToWeChat();
  }
}

async function dequeueNextQuestion() {
  if (pendingQuestions) { log('[DEQUEUE] skip: already a pending question'); return; }
  while (pendingQuestionQueue.length > 0) {
    const next = pendingQuestionQueue.shift();
    pendingQuestions = next;
    if (next.sessionID) currentSessionId = next.sessionID;
    const autoClear = setTimeout(() => {
      if (pendingQuestions?.askTimestamp === next.askTimestamp) { pendingQuestions = null; dequeueNextQuestion(); }
    }, QUESTION_AUTO_CLEAR_MS);
    autoClear.unref?.();
    // Generate notification for the next question
    await fetchSessionName(next.sessionID);
    const sesLabel = next.sessionID ? `[${getSessionName(next.sessionID)}] ` : '';
    const qi = next.questions?.[0];
    if (!qi) { pendingQuestions = null; clearTimeout(autoClear); continue; }
    const multi = next.questions.length > 1;
    let text = (multi ? `📌 下一题（共${next.questions.length}题）` : `📌 下一题`);
    if (sesLabel) text = sesLabel + text;
    text += formatQuestionBody(next.questions);
    broadcastNotification(text);
    return;
  }
}

async function skipQuestion(sid, arg, msgId) {
  const all = getAllQuestions();
  if (all.length === 0) {
    reply(sid, '⚠️ 当前没有待回答的问题');
    if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  let qIdx = 0;
  if (arg) {
    qIdx = parseInt(arg.trim(), 10) - 1;
    if (isNaN(qIdx) || qIdx < 0 || qIdx >= all.length) {
      reply(sid, `⚠️ 编号无效 (1-${all.length})`);
      if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
  }

  // Get the target question
  let qData;
  if (pendingQuestions) {
    if (qIdx === 0) {
      qData = pendingQuestions;
      pendingQuestions = null;
      await dequeueNextQuestion();
    } else {
      qData = pendingQuestionQueue.splice(qIdx - 1, 1)[0];
    }
  } else {
    qData = pendingQuestionQueue.splice(qIdx, 1)[0];
  }

  const requestID = qData?.requestID;
  const qSessID = qData?.sessionID;
  if (requestID && qSessID) {
    try {
      await fetch(`${SERVER}/api/session/${encodeURIComponent(qSessID)}/question/${encodeURIComponent(requestID)}/reject`, {
        method: 'POST',
        headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      log(`[SKIP] rejected question ${requestID.slice(0,16)}`);
    } catch (err) {
      log(`[SKIP] reject error: ${err.message}`);
    }
  }

  const remaining = getAllQuestions().length;
  const note = remaining > 0 ? `（还剩${remaining}题，/qlist (/ql, /questions) 查看，/qselect (/qs, /qsel) <编号> 切换）` : '';
  fetchSessionName(qData?.sessionID).catch(() => {});
  const sesLabel = qData?.sessionID ? ` [${getSessionName(qData.sessionID)}]` : '';
  reply(sid, `⏭️ 已跳过${sesLabel}，${note}`);
  if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
}

/* ───────── Working Notice ───────── */

function armWorkingNotice(sid) {
  disarmWorkingNotice();
  workingTimer = setTimeout(() => {
    workingTimer = null;
    if (responseSent) return;
    log(`[WORKING] sending working notice to ${sid.slice(0,12)}`);
    try {
      reply(sid, `⏳ 仍在处理中...\n「${lastPromptText.slice(0, 60)}」`);
      flushToWeChat();
    } catch (e) {
      log(`[WORKING] error: ${e.message}`);
    }
  }, WORKING_NOTICE_DELAY);
  workingTimer.unref?.();
}

function disarmWorkingNotice() {
  if (workingTimer) {
    clearTimeout(workingTimer);
    workingTimer = null;
  }
}

/* ───────── AI Prompt Forwarding ───────── */

async function forwardToAIAsync(sid, targetId, text) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SESSION_MESSAGE_TIMEOUT);
    let res;
    try {
      res = await fetch(`${SERVER}/session/${encodeURIComponent(targetId)}/message`, {
        method: 'POST',
        headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text }], agent: currentAgent }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      disarmWorkingNotice();
      responseSent = true;
      responseForSession = targetId;
      const errText = await res.text();
      reply(sid, `⚠️ 服务器错误 (${res.status}): ${errText.slice(0, 100)}`);
      await drainPendingNotifications();
      flushToWeChat();
      return;
    }

    const data = await res.json();
    await drainPendingNotifications();
    if (responseSent && responseForSession === targetId) {
      log(`[FWD] response already sent for ${sid.slice(0,12)}, skipping`);
      return;
    }
    if (responseForSession !== targetId) {
      log(`[FWD] stale response for session ${targetId?.slice(0,12)}, expected ${responseForSession?.slice(0,12)}, skipping`);
      return;
    }
    responseSent = true;
    disarmWorkingNotice();
    idleNotified.add(targetId); // prevent "完成" from session.status(idle)
    pendingReplyText = ''; // clear any residual SSE deltas
    const formatted = formatReply(data);
    if (formatted) {
      reply(sid, formatted);
      flushToWeChat();
    }
  } catch (err) {
    disarmWorkingNotice();
    if (responseForSession !== targetId) return; // superseded by newer prompt
    if (err.name === 'AbortError') {
      const accumulated = pendingReplyText.trim();
      log(`[FWD] timeout: lastSid=${(lastPromptSessionId||'?').slice(0,12)} targetId=${(targetId||'?').slice(0,12)} text_len=${text.length} pending_len=${pendingReplyText.length} accumulated_len=${accumulated.length}`);
      pendingReplyText = '';
      responseSent = true;
      responseForSession = targetId;
      idleNotified.add(targetId);
      disarmWorkingNotice();
      if (accumulated) {
        reply(sid, `🤖 ${accumulated}`);
      } else {
        reply(sid, '⏰ 请求超时，请重试');
      }
    } else {
      responseSent = true;
      responseForSession = targetId;
      reply(sid, `❌ ${err.message}`);
    }
    await drainPendingNotifications();
    flushToWeChat();
  }
}

function formatReply(data) {
  const parts = data?.parts || [];
  if (!parts.length) return '🤖 （无文本响应）';

  const texts = parts.filter(p => p.type === 'text' && p.text).map(p => p.text);
  const mainText = texts.join('\n').trim();
  return mainText ? `🤖 ${mainText}` : '🤖 （完成）';
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
    currentSessionId = 'sess_' + Date.now();
    saveSession(currentSessionId);
    sendResponse(msg.id, { sessionId: currentSessionId, configOptions: [], modes: null, models: null });
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
  } catch (e) {
    log(`[ACP] session/list fetch failed: ${e.message}`);
    sendResponse(msg.id, { sessions: [] });
  }
}

async function handleLoadSession(msg) {
  const sessionId = msg.params?.sessionId;
  if (!sessionId) { sendResponse(msg.id, { _meta: { error: 'sessionId required' } }); return; }
  try {
    const data = await apiFetch(`/session/${encodeURIComponent(sessionId)}`);
    currentSessionId = data.id || sessionId;
    saveSession(currentSessionId);
    sendResponse(msg.id, { sessionId: currentSessionId, cwd: data.directory || '', title: data.title || '',
      updatedAt: data.time?.updated ? new Date(data.time.updated).toISOString() : undefined });
  } catch (err) {
    sendResponse(msg.id, { _meta: { error: err.message } });
  }
}

async function handleCancel(msg) {
  const cancelTargets = [msg.params?.sessionId, currentSessionId].filter(Boolean);
  for (const id of [...new Set(cancelTargets)]) {
    try { await fetch(`${SERVER}/session/${encodeURIComponent(id)}/abort`, { method: 'POST', headers: { Authorization: AUTH }, signal: AbortSignal.timeout(5000) }); } catch {}
  }
  disarmWorkingNotice();
  pendingReplyText = '';
  responseSent = true;
  responseForSession = null;
  lastPromptSessionId = null;
  lastPromptSid = null;
  // ACP 规范: session/cancel 是通知 (JSON-RPC notification)，无 id 时不能发响应
  if (msg.id != null) sendResponse(msg.id, {});
}

/* ───────── Workspace ───────── */

function wsPathEqual(a, b) {
  if (!a || !b) return a === b;
  try { return resolve(a).toLowerCase() === resolve(b).toLowerCase(); } catch { return a.toLowerCase() === b.toLowerCase(); }
}

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
      const match = list.find(w => wsPathEqual(w.path, saved.path));
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

function saveWorkspaces(list) {
  try { writeFileSync(WORKSPACES_FILE, JSON.stringify(list, null, 2)); } catch {}
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
  s.lastActive = Date.now();
  return s;
}

/* ───────── Settings ───────── */

let settings = { cleanupDays: 7 };

function loadSettings() {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
      if (data && typeof data.cleanupDays === 'number') settings.cleanupDays = data.cleanupDays;
    }
  } catch (e) { log(`[SETTINGS] load failed: ${e.message}`); }
}
function saveSettings() {
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { log(`[SETTINGS] save failed: ${e.message}`); }
}

async function handleAutoClean(sid, arg, msgId) {
  if (!arg) {
    reply(sid, `🔧 自动清理设置\n不活跃阈值: ${settings.cleanupDays} 天\n/autoclean <天数> 修改`);
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  const days = parseInt(arg, 10);
  if (isNaN(days) || days < 1) {
    reply(sid, '⚠️ 请输入有效天数（至少 1 天）');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  settings.cleanupDays = days;
  saveSettings();
  reply(sid, `✅ 自动清理阈值已设为 ${days} 天`);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

/* ───────── I/O Helpers ───────── */

const MAX_REPLY_LENGTH = 2000;

function reply(sid, text) {
  log(`[REPLY] to=${sid.slice(0,12)} len=${text.length} text=${text.slice(0,80).replace(/\n/g,'\\n')}`);
  if (text.length <= MAX_REPLY_LENGTH) {
    sendNotification('session/update', {
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId: uuid() },
    });
    return;
  }
  for (let i = 0; i < text.length; i += MAX_REPLY_LENGTH) {
    const chunk = text.slice(i, i + MAX_REPLY_LENGTH);
    sendNotification('session/update', {
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk }, messageId: uuid() },
    });
  }
}

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
  log(`→ response id=${id} ok${result._meta?.error ? ' ERR=' + result._meta.error : ''}`);
}

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(msg + '\n');
  log(`→ notify ${method} ${params.sessionId ? 'sid='+params.sessionId.slice(0,12) : ''} ${params.update?.sessionUpdate || ''} ${params.update?.content?.type || ''}`);
}

async function apiFetch(path, opts = {}) {
  const method = opts.method || 'GET';
  log(`[API] ${method} ${path}`);
  const { headers: extraHeaders, ...rest } = opts;
  const res = await fetch(`${SERVER}${path}`, {
    headers: { Authorization: AUTH, ...extraHeaders },
    signal: AbortSignal.timeout(10000),
    ...rest,
  });
  log(`[API] => ${res.status} ${method} ${path}`);
  if (!res.ok) {
    let errText;
    try { errText = await res.text(); } catch { errText = res.statusText; }
    log(`[API] => ERR ${res.status}: ${errText.slice(0, 150)}`);
    throw new Error(`${res.status}: ${errText.slice(0, 200)}`);
  }
  if (opts.method === 'DELETE' || res.status === 204) {
    log(`[API] => ${res.status} no body`);
    return {};
  }
  const text = await res.text();
  log(`[API] => body=${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { log(`[API] => non-JSON body, returning {}`); return {}; }
}

/* ═══════════════════════════════════════
   Notification System — SSE Event Monitor
   ═══════════════════════════════════════ */

let sessionNames = new Map();
let idleNotified = new Set();
let recentNotifications = new Map(); // text → timestamp, dedup within 60s
let perUserRecent = new Map(); // sid → { text → timestamp }
let proactiveTimer = null;
let recentEventIds = new Set(); // event ID → timestamp, dedup within 10s
let lastNotifyPerSid = new Map(); // sid → timestamp, notification rate limiting
let sseReader = null;          // current SSE reader (for restart on workspace change)

const DEDUP_WINDOW = 60000;
const PER_USER_DEDUP_WINDOW = 60000;

function broadcastNotification(text) {
  const now = Date.now();
  const textBrief = text.slice(0, 60).replace(/\n/g, '\\n');

  // Global text-level dedup: skip if same text was sent within 60s
  const lastSent = recentNotifications.get(text);
  if (lastSent && now - lastSent < DEDUP_WINDOW) {
    log(`[BROADCAST] GLOBAL DEDUP skip: ${textBrief} (age=${now-lastSent}ms)`);
    return;
  }
  recentNotifications.set(text, now);
  log(`[BROADCAST] new: ${textBrief}`);
  // Clean old global entries
  if (recentNotifications.size > 50) {
    let removed = 0;
    for (const [t, ts] of recentNotifications) {
      if (now - ts > DEDUP_WINDOW * 2) { recentNotifications.delete(t); removed++; }
    }
    log(`[BROADCAST] cleaned ${removed} old dedup entries`);
  }

  const targets = subscribers.filter(s => !s.muted);
  if (targets.length === 0) { log(`[BROADCAST] no active subscribers`); return; }
  // Pick the most recently active subscriber; prefer last prompt source if exists
  targets.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  let best = targets[0];
  if (lastPromptSid) {
    const cur = targets.find(t => t.sid === lastPromptSid);
    if (cur) best = cur;
  }
  log(`[BROADCAST] pushing to best subscriber: sid=${best.sid.slice(0,12)} (lastActive=${best.lastActive ? new Date(best.lastActive).toISOString() : 'never'})`);
  const t = best;
  let userRecent = perUserRecent.get(t.sid);
  if (userRecent && userRecent.has(text) && now - userRecent.get(text) < PER_USER_DEDUP_WINDOW) {
    log(`[BROADCAST] per-user dedup skip: sid=${t.sid.slice(0,12)} ${textBrief}`);
    return;
  }
  if (!userRecent) {
    userRecent = new Map();
    perUserRecent.set(t.sid, userRecent);
  }
  userRecent.set(text, now);
  if (userRecent.size > 30) {
    const cutoff = now - PER_USER_DEDUP_WINDOW * 2;
    for (const [txt, ts] of userRecent) {
      if (ts < cutoff) userRecent.delete(txt);
    }
  }

  pendingNotifications.push({ sid: t.sid, text });
  log(`[BROADCAST] queued for sid=${t.sid.slice(0,12)} pendingTotal=${pendingNotifications.length}`);
  // Schedule proactive flush if no user message arrives within 15s
  if (!proactiveTimer) {
    proactiveTimer = setTimeout(() => {
      log(`[TIMER] proactive drain firing`);
      proactiveTimer = null;
      drainPendingNotifications(true).catch(e => log(`[TIMER] drain error: ${e.message}`));
    }, 15000);
    proactiveTimer.unref?.();
    log(`[BROADCAST] proactive timer set for 15s`);
  }
}

async function drainPendingNotifications(forceFlush) {
  if (draining) {
    log(`[DRAIN] skip: already draining`);
    return;
  }
  if (pendingNotifications.length === 0) {
    log(`[DRAIN] skip: no pending`);
    return;
  }
  draining = true;
  const batchSize = pendingNotifications.length;
  log(`[DRAIN] start: ${batchSize} pending, forceFlush=${forceFlush}`);
  try {
    const batch = pendingNotifications.splice(0);
    const grouped = new Map();
    for (const n of batch) {
      const existing = grouped.get(n.sid) || [];
      existing.push(n.text);
      grouped.set(n.sid, existing);
    }
    log(`[DRAIN] grouped into ${grouped.size} unique sid(s)`);
    for (const [sid, texts] of grouped) {
      // Rate limiting: ensure minimum interval between notifications to same user
      const lastSent = lastNotifyPerSid.get(sid) || 0;
      const elapsed = Date.now() - lastSent;
      if (elapsed < NOTIFICATION_RATE_LIMIT_MS) {
        const waitMs = NOTIFICATION_RATE_LIMIT_MS - elapsed;
        log(`[DRAIN] rate limit: waiting ${waitMs}ms for sid=${sid.slice(0,12)}`);
        await new Promise(r => setTimeout(r, waitMs));
      }
      lastNotifyPerSid.set(sid, Date.now());
      const unique = [...new Set(texts)];
      log(`[DRAIN] sid=${sid.slice(0,12)}: ${texts.length} texts -> ${unique.length} unique`);
      if (unique.length > 1) {
        for (let i = 0; i < unique.length; i++) {
          log(`[DRAIN]   [${i}]: ${unique[i].slice(0,80).replace(/\n/g,'\\n')}`);
        }
      }
      const permLines = unique.filter(t => /^#\d+/.test(t));
      if (permLines.length > 0) {
        const others = unique.filter(t => !/^#\d+/.test(t));
        let combined = permLines.join('\n');
        combined += '\n/allow (/a) 批准 | /deny (/d) 拒绝 | /trust (/t) 信任 | +<编号>';
        if (others.length > 0) combined += '\n' + others.join('\n');
        try { reply(sid, combined); } catch (e) { log(`[DRAIN] reply error for ${sid}: ${e.message}`); }
      } else {
        try { reply(sid, unique.join('\n')); } catch (e) { log(`[DRAIN] reply error for ${sid}: ${e.message}`); }
      }
    }
    if (forceFlush) {
      log(`[DRAIN] force flush requested`);
      flushToWeChat();
    }
  } catch (e) {
    log(`[DRAIN] error: ${e.message}`);
  } finally {
    draining = false;
    log(`[DRAIN] end`);
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

// Handle side-effects for SSE events (session tracking, etc.)
async function handleSseSideEffect(type, props) {
  switch (type) {
    case 'tui.session.select': {
      const sid = props.sessionID || props.id;
      if (!sid || sid === currentSessionId) return;
      log(`[SSE] tui.session.select: local switched to ${sid.slice(0,12)}`);
      const oldId = currentSessionId;
      currentSessionId = sid;
      saveSession(sid);
      await fetchSessionName(sid);
      if (oldId) {
        broadcastNotification(`🔄 已跟随到会话「${getSessionName(sid)}」`);
      }
      return;
    }
    case 'session.created': {
      const sid = props.sessionID || props.id;
      if (!sid) return;
      log(`[SSE] session.created: ${sid.slice(0,12)}`);
      // Optionally auto-follow new sessions (if they match current directory)
      const dir = props.directory;
      if (dir && normalizeDir(dir) === normalizeDir(getWorkspaceDir())) {
        currentSessionId = sid;
        saveSession(sid);
        await fetchSessionName(sid);
        broadcastNotification(`🆕 新会话已创建，已自动跟随`);
      }
      return;
    }
  }
}

function normalizeDir(p) {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
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
      const questions = props.questions || [];
      const ts = Date.now();
      const qData = { sessionID: props.sessionID, requestID: props.requestID, questions, askTimestamp: ts };
      // Dedup: skip if same requestID is already active or queued
      if (qData.requestID) {
        if (pendingQuestions && pendingQuestions.requestID === qData.requestID) {
          log(`[EVENT] question.asked: dedup (already active)`);
          return null;
        }
        if (pendingQuestionQueue.some(q => q.requestID === qData.requestID)) {
          log(`[EVENT] question.asked: dedup (already queued)`);
          return null;
        }
      }
      if (pendingQuestions) {
        pendingQuestionQueue.push(qData);
        log(`[EVENT] question.asked: queued (${pendingQuestionQueue.length} in queue)`);
        return null; // notification will be generated by dequeueNextQuestion
      }
      pendingQuestions = qData;
      setTimeout(() => {
        if (pendingQuestions?.askTimestamp === ts) { pendingQuestions = null; dequeueNextQuestion(); }
      },     QUESTION_AUTO_CLEAR_MS).unref?.();
      log(`[EVENT] question.asked: stored ${questions.length} questions`);
      await fetchSessionName(props.sessionID);
      const sesLabel = props.sessionID ? `[${getSessionName(props.sessionID)}] ` : '';
      const qi = questions[0];
      if (!qi) return '💬 AI 提出了一个问题（无详情）';
      const multi = questions.length > 1;
      let msg = multi ? `💬 待回答（共${questions.length}题）` : `💬 需要你回答`;
      if (sesLabel) msg = sesLabel + msg;
      msg += formatQuestionBody(questions);
      return msg;
    }
    case 'permission.asked': {
      const t = props.permission || props.action || '操作';
      const rid = props.requestID || props.id;
      const sesId = props.sessionID;
      log(`[EVENT] permission.asked rid=${(rid||'?').slice(0,16)} perm=${t} sesId=${(sesId||'?').slice(0,12)}`);
      log(`[EVENT]   props keys=[${Object.keys(props).join(',')}] patterns=${JSON.stringify(props.patterns)} resources=${JSON.stringify(props.resources)} metadata=${JSON.stringify(props.metadata)}`);
      const p = props.patterns?.[0] || props.resources?.[0] || props.metadata?.path || props.metadata?.file || props.metadata?.command || '';
      log(`[EVENT]   p="${p?.slice(0,100)||'(empty)'}"`);
      if (rid) {
        if (pendingPermissions.has(rid)) {
          log(`[EVENT] permission.asked: duplicate rid, suppressing notification`);
          return null;
        }
        log(`[EVENT] permission.asked: storing rid in pendingPermissions`);
        pendingPermissions.set(rid, { sessionID: sesId, permission: t, patterns: p, ts: Date.now() });
        setTimeout(() => {
          log(`[TIMER] auto-clean rid=${rid.slice(0,16)}...`);
          pendingPermissions.delete(rid);
        },     QUESTION_AUTO_CLEAR_MS).unref?.();
        // Same-session dedup: only suppress if this has NO path and session already has pending
        // (approving one typically auto-approves related requests, but path info is critical)
        if (!p) {
          let sessionHasPending = false;
          for (const [existingRid, info] of pendingPermissions) {
            if (existingRid !== rid && info.sessionID === sesId) { sessionHasPending = true; break; }
          }
          if (sessionHasPending) {
            log(`[EVENT] permission.asked: session ${sesId?.slice(0,12)} already has pending, no path to show, suppressing`);
            return null;
          }
        }
      }
      await fetchSessionName(sesId);
      const sesLabel = sesId ? `[${getSessionName(sesId)}] ` : '';
      // WeChat eats leading spaces, so no indentation — path line starts directly after newline
      const pathLine = p ? `\n${p}` : '';
      const idx = pendingPermissions.size;
      return `#${idx} ${sesLabel}${t}${pathLine}`;
    }
    case 'permission.replied': {
      const rid = props.requestID;
      log(`[EVENT] permission.replied rid=${(rid||'?').slice(0,16)}`);
      if (rid && pendingPermissions.has(rid)) {
        pendingPermissions.delete(rid);
        log(`[EVENT] permission.replied: removed rid from pendingPermissions`);
      }
      return null;
    }
    case 'question.replied':
    case 'question.rejected': {
      const qrid = props.requestID;
      log(`[EVENT] question.replied/rejected rid=${(qrid||'?').slice(0,16)}`);
      if (qrid) {
        if (pendingQuestions && pendingQuestions.requestID === qrid) {
          pendingQuestions = null;
          await dequeueNextQuestion();
        }
        const before = pendingQuestionQueue.length;
        pendingQuestionQueue = pendingQuestionQueue.filter(q => q.requestID !== qrid);
        if (pendingQuestionQueue.length !== before) {
          log(`[EVENT] removed ${before - pendingQuestionQueue.length} from queue`);
        }
      }
      return null;
    }
    case 'session.idle': {
      // Clear stale pending questions for this session
      if (pendingQuestions && pendingQuestions.sessionID === props.sessionID) {
        pendingQuestions = null;
      }
      pendingQuestionQueue = pendingQuestionQueue.filter(q => q.sessionID !== props.sessionID);

      if (props.sessionID && props.sessionID === lastPromptSessionId) {
        const text = pendingReplyText.trim();
        pendingReplyText = '';
        if (text) {
          responseSent = true;
          responseForSession = props.sessionID;
          disarmWorkingNotice();
          idleNotified.add(props.sessionID);
          log(`[IDLE] replying with text len=${text.length}`);
          reply(lastPromptSid, `🤖 ${isPhone() ? text : text}`);
          flushToWeChat();
          return null;
        }
        if (!responseSent) {
          log(`[IDLE] no text accumulated, deferring to forwardToAIAsync`);
          idleNotified.add(props.sessionID);
          return null;
        }
      }
      // PHONE mode: suppress completion notifications
      if (isPhone()) return null;
      return idleNotification(props);
    }
    case 'session.status': {
      const st = props.status;
      if (!st) return null;
      if (st.type === 'idle') {
        updateSessionState(props.sessionID, { retryCount: 0, busySince: undefined });
        if (props.sessionID && props.sessionID === lastPromptSessionId) {
          const text = pendingReplyText.trim();
          pendingReplyText = '';
          if (text) {
            responseSent = true;
            responseForSession = props.sessionID;
            disarmWorkingNotice();
            idleNotified.add(props.sessionID);
            log(`[STATUS.IDLE] replying with text len=${text.length}`);
            reply(lastPromptSid, `🤖 ${text}`);
            flushToWeChat();
            return null;
          }
        }
        if (isPhone()) return null;
        return idleNotification(props);
      }
      if (st.type === 'retry') {
        if (isPhone()) return null;
        const sid = props.sessionID;
        const state = updateSessionState(sid, { retryCount: (sessionStates.get(sid)?.retryCount || 0) + 1 });
        if (state.retryCount >= 3) return `🔄 AI重试${state.retryCount}次未恢复`;
        return null;
      }
      if (st.type === 'busy') {
        idleNotified.delete(props.sessionID);
        updateSessionState(props.sessionID, { busySince: Date.now(), lastActivity: Date.now(), retryCount: 0 });
        return null;
      }
      return null;
    }
    case 'message.part.delta':
    case 'message.part.updated': {
      const psid = props.sessionID;
      if (psid) updateSessionState(psid, { lastActivity: Date.now() });
      // Only accumulate text parts for the active session
      const partType = props.field || props.partType;
      const delta = props.delta || props.part?.text || '';
      log(`[SSE] delta: type=${type} field="${partType}" delta_len=${delta.length} psid=${(psid||'?').slice(0,12)} lastSid=${(lastPromptSessionId||'?').slice(0,12)} pending_len=${pendingReplyText.length}`);
      if (psid && psid === lastPromptSessionId && partType === 'text' && delta) {
        if (pendingReplyText.length < MAX_ACCUMULATED_TEXT) {
          pendingReplyText += delta;
        } else if (!pendingReplyText.endsWith('…（过长截断）')) {
          pendingReplyText += '\n\n…（内容过长，请在 OpenCode 界面查看完整输出）';
        }
      }
      return null;
    }
    default:
      return null;
  }
}

async function fetchSessionName(id) {
  if (!id || sessionNames.has(id)) return;
  try {
    const data = await apiFetch(`/session/${encodeURIComponent(id)}`);
    if (data.title) sessionNames.set(id, data.title);
  } catch {}
}

function restartSSE() {
  log('[SSE] Restart requested');
  if (sseReader) {
    try { sseReader.cancel(); } catch (e) { log(`[SSE] cancel error: ${e.message}`); }
    sseReader = null;
  }
}

// ── SSE connection ──

async function connectSSE() {
  let retryDelay = 1000;
  const maxDelay = 30000;

  while (true) {
    try {
      log(`[SSE] Connecting... (retryDelay=${retryDelay}ms)`);
      const eventUrl = `${SERVER}/global/event?directory=${encodeURIComponent(getWorkspaceDir())}`;
      log(`[SSE] URL: ${eventUrl}`);
      const abortControl = new AbortController();
      const connTimer = setTimeout(() => abortControl.abort(), 15000);
      let response;
      try {
        response = await fetch(eventUrl, {
          headers: { Authorization: AUTH, 'x-opencode-directory': getWorkspaceDir() },
          signal: abortControl.signal,
        });
      } finally {
        clearTimeout(connTimer);
      }
      if (!response.ok) throw new Error(`SSE ${response.status}`);
      if (!response.body) throw new Error('SSE body is null');
      sseReader = null;
      retryDelay = 1000;
      log('[SSE] Connected successfully');
      syncPendingFromServer().catch(e => log(`[SYNC] reconnect sync error: ${e.message}`));

      const reader = response.body.getReader();
      sseReader = reader;
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
              const rawBrief = currentData.slice(0, 400);
              log(`[SSE] raw data: ${rawBrief}`);
              try {
                const parsed = JSON.parse(currentData);
                const payload = parsed.payload || parsed;
                const eventType = payload.type || currentEvent;
                const eventId = payload.id;
                const props = payload.properties || {};

                // Event-level dedup: skip if same event ID seen within 10s
                if (eventId && recentEventIds.has(eventId)) {
                  log(`[SSE] EVENT DEDUP skip: id=${eventId.slice(0,24)}`);
                  currentEvent = '';
                  currentData = '';
                  continue;
                }
                if (eventId) {
                  recentEventIds.add(eventId);
                  setTimeout(() => recentEventIds.delete(eventId), 10000).unref?.();
                }

                if (props.id) props.requestID ??= props.id;
                if (payload.id && !props.requestID) props.requestID ??= payload.id;
                log(`[SSE] parsed: event=${eventType} sessionID=${props.sessionID || '?'} id=${props.id || payload.id || '-'}`);
                if (eventType.startsWith('permission') || eventType.startsWith('question') || eventType === 'session.idle' || eventType === 'session.error' || eventType === 'session.status') {
                  log(`[SSE] ** ${eventType} props keys=[${Object.keys(props).join(',')}]`);
                }
                if (eventType === 'permission.asked' || eventType === 'permission.replied') {
                  log(`[SSE]    requestID=${props.requestID || '?'} permission=${props.permission || props.action || '?'}`);
                }
                // Handle session tracking side-effects before notification
                await handleSseSideEffect(eventType, props).catch(e => log(`[SSE] side-effect error: ${e.message}`));

                try {
                  const text = await eventToNotification(eventType, props);
                  if (text) {
                    log(`[SSE] notification generated: ${text.slice(0, 80).replace(/\n/g,'\\n')}`);
                    broadcastNotification(text);
                  } else {
                    log(`[SSE] eventToNotification returned null (suppressed)`);
                  }
                } catch (e) {
                  log(`[SSE] eventToNotification error: ${e.message}`);
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
            currentData += trimmed.slice(5).replace(/^ /, '') + '\n';
          }
        }
      }
      log('[SSE] Stream ended, reconnecting...');
    } catch (err) {
      log(`[SSE] Error: ${err.message}, retry in ${retryDelay}ms`);
    } finally {
      sseReader = null;
    }

    await new Promise(r => setTimeout(r, retryDelay));
    retryDelay = Math.min(retryDelay * 2, maxDelay);
  }
}

// ── Watchdog: detect stuck sessions & clean stale subscribers ──

function startWatchdog() {
  const STUCK_WARN_MS = 5 * 60 * 1000;
  const STUCK_ALERT_MS = 10 * 60 * 1000;
  let lastCleanupCheck = 0;
  const CLEANUP_INTERVAL = 30 * 60 * 1000;

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
        if (state.lastActivity && state.lastActivity < staleCutoff) {
          sessionStates.delete(id);
          sessionNames.delete(id);
          idleNotified.delete(id);
        }
      }

      // Periodic subscriber cleanup & server sync (run every 30 min)
      if (now - lastCleanupCheck > CLEANUP_INTERVAL) {
        lastCleanupCheck = now;
        syncPendingFromServer().catch(e => log(`[SYNC] periodic sync error: ${e.message}`));
        const inactiveCutoff = now - settings.cleanupDays * 24 * 60 * 60 * 1000;
        const before = subscribers.length;
        subscribers = subscribers.filter(s => {
          if ((s.lastActive || 0) < inactiveCutoff) {
            log(`[CLEANUP] removing inactive subscriber ${s.sid.slice(0, 16)} (lastActive: ${new Date(s.lastActive).toISOString()})`);
            return false;
          }
          return true;
        });
        if (subscribers.length < before) {
          saveSubscribers();
          log(`[CLEANUP] removed ${before - subscribers.length} inactive subscriber(s), remaining: ${subscribers.length}`);
        }
        // Clean per-user dedup cache for removed subscribers
        const activeSids = new Set(subscribers.map(s => s.sid));
        for (const [sid] of perUserRecent) {
          if (!activeSids.has(sid)) perUserRecent.delete(sid);
        }
        // Also clean old entries in all remaining per-user maps
        const dedupCutoff = now - PER_USER_DEDUP_WINDOW * 2;
        for (const [, userMap] of perUserRecent) {
          for (const [txt, ts] of userMap) {
            if (ts < dedupCutoff) userMap.delete(txt);
          }
        }
      }
    } catch (e) {
      log(`[WATCHDOG] error: ${e.message}`);
    }
  }, 30000).unref();
}

// ── Startup ──

loadSubscribers();
loadSettings();
connectSSE();
startWatchdog();
log('Bot started');
