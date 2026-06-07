import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const SERVER = 'http://localhost:4096';
const AUTH = 'Basic ' + Buffer.from('opencode:opencode').toString('base64');
const WORK_DIR = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = join(WORK_DIR, '.wechat-session.json');
const WORKSPACES_FILE = join(WORK_DIR, '.wechat-workspaces.json');
const SESSION_MAX_SHOW = 20;

const M = Object.freeze({
  IDLE: 0, MAIN: 1, LIST: 2, CONFIRM_SWITCH: 3, CONFIRM_DELETE: 4,
  RENAME_SELECT: 5, RENAME_INPUT: 6, NEW_WORKSPACE: 7, NEW_TASK: 8, NEW_CONFIRM: 9,
});

function log(...args) { process.stderr.write(`[wechat-adapter] ${args.join(' ')}\n`); }

function uuid() { return randomUUID ? randomUUID() : 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

function emoji(s) { return s; }

const rl = createInterface({ input: process.stdin });
let serverSessionId = loadSession();
let lineBuf = '';
const menuStore = new Map();

rl.on('line', (line) => {
  lineBuf += line;
  let msg;
  try { msg = JSON.parse(lineBuf); lineBuf = ''; } catch { return; }
  const method = msg.method;
  log(`Received method=${method}, id=${msg.id}`);
  if (method === 'initialize' && msg.id != null) {
    sendResponse(msg.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { audio: false, embeddedContext: false, image: false },
        sessionCapabilities: { list: {} },
      },
      agentInfo: { name: 'opencode-wechat-adapter', version: '3.0.0' },
    });
  } else if (method === 'session/new' && msg.id != null) {
    handleNewSession(msg, msg.params?.cwd);
  } else if (method === 'session/list' && msg.id != null) {
    handleListSessions(msg);
  } else if (method === 'session/load' && msg.id != null) {
    handleLoadSession(msg);
  } else if (method === 'session/prompt' && msg.id != null) {
    handlePrompt(msg);
  } else if (method === 'session/cancel') {
    handleCancel(msg).catch(() => {});
  }
});

/* ───────── Menu State Machine ───────── */

function getMenu(sid) {
  if (!menuStore.has(sid)) menuStore.set(sid, { state: M.IDLE, sessions: [], idx: 0, ctx: {} });
  return menuStore.get(sid);
}

function resetMenu(sid) { menuStore.delete(sid); }

async function handlePrompt(msg) {
  const params = msg.params || {};
  const sid = params.sessionId || serverSessionId || 'sess_wechat_fallback';
  const blocks = params.prompt || [];
  const text = blocks.map(b => b.text || '').join('').trim();
  log(`handlePrompt sessionId=${sid}, text="${text.slice(0, 80)}"`);

  if (!text) { sendResponse(msg.id, { stopReason: 'end_turn' }); return; }

  const menu = getMenu(sid);
  if (menu.state !== M.IDLE) {
    await handleMenuInput(sid, text, msg.id);
    return;
  }

  if (text === '/session' || text === '/s' || text === '/help') {
    menu.state = M.MAIN;
    await showMainMenu(sid, msg.id);
    return;
  }

  await forwardToAI(sid, text, msg.id);
}

async function handleMenuInput(sid, text, msgId) {
  const menu = getMenu(sid);
  const num = parseInt(text, 10);

  switch (menu.state) {
    case M.MAIN:
      if (num === 0) { sendReply(sid, '✅ 已退出菜单'); resetMenu(sid); sendResponse(msgId, { stopReason: 'end_turn' }); return; }
      if (num === 1) { menu.state = M.LIST; menu.ctx.mode = 'view'; await showSessionList(sid, msgId); return; }
      if (num === 2) { menu.state = M.NEW_WORKSPACE; await showWorkspaceList(sid, msgId); return; }
      if (num === 3) { menu.state = M.LIST; menu.ctx.mode = 'switch'; await showSessionList(sid, msgId); return; }
      if (num === 4) { menu.state = M.RENAME_SELECT; await showSessionList(sid, msgId); return; }
      if (num === 5) { menu.state = M.LIST; menu.ctx.mode = 'delete'; await showSessionList(sid, msgId); return; }
      if (num === 6) { await showTaskStatus(sid, msgId); return; }
      await showMainMenu(sid, msgId);
      return;

    case M.LIST:
    case M.RENAME_SELECT:
      if (num === 0) { menu.state = M.MAIN; await showMainMenu(sid, msgId); return; }
      const sessions = menu.sessions;
      if (num < 1 || num > sessions.length) { sendReply(sid, `⚠️ 请输入 1-${sessions.length} 之间的编号`); sendResponse(msgId, { stopReason: 'end_turn' }); return; }
      menu.idx = num - 1;
      const sel = sessions[menu.idx];
      if (menu.state === M.LIST) {
        if (menu.ctx.mode === 'switch') { menu.state = M.CONFIRM_SWITCH; await confirmSwitch(sid, sel, msgId); }
        else if (menu.ctx.mode === 'delete') { menu.state = M.CONFIRM_DELETE; await confirmDelete(sid, sel, msgId); }
        else { await showSessionDetail(sid, sel, msgId); }
      } else {
        menu.state = M.RENAME_INPUT; menu.ctx.targetId = sel.sessionId;
        sendReply(sid, `✏️  请输入"${sel.title || '未命名'}"的新名称：\n回复 0 取消`);
        sendResponse(msgId, { stopReason: 'end_turn' });
      }
      return;

    case M.CONFIRM_SWITCH:
    case M.CONFIRM_DELETE:
      if (num === 0) { menu.state = M.LIST; menu.ctx.mode = menu.state === M.CONFIRM_SWITCH ? 'switch' : 'delete'; await showSessionList(sid, msgId); return; }
      if (num === 1) {
        if (menu.state === M.CONFIRM_SWITCH) { await doSwitchSession(sid, menu.ctx.targetId, msgId); }
        else { await doDeleteSession(sid, menu.ctx.targetId, menu.ctx.targetTitle, msgId); }
        return;
      }
      sendReply(sid, '⚠️ 回复 1 确认，0 取消'); sendResponse(msgId, { stopReason: 'end_turn' });
      return;

    case M.RENAME_INPUT:
      if (text === '0') { menu.state = M.MAIN; await showMainMenu(sid, msgId); return; }
      await doRenameSession(sid, menu.ctx.targetId, text, msgId);
      return;

    case M.NEW_WORKSPACE:
      if (num === 0) { menu.state = M.MAIN; await showMainMenu(sid, msgId); return; }
      const wsList = loadWorkspaces();
      if (num < 1 || num > wsList.length) { sendReply(sid, `⚠️ 请输入 1-${wsList.length} 之间的编号`); sendResponse(msgId, { stopReason: 'end_turn' }); return; }
      menu.ctx.workspace = wsList[num - 1];
      menu.state = M.NEW_TASK;
      sendReply(sid, `📝 工作区: ${wsList[num - 1].name}\n请输入任务描述：\n回复 0 取消`);
      sendResponse(msgId, { stopReason: 'end_turn' });
      return;

    case M.NEW_TASK:
      if (text === '0') { menu.state = M.MAIN; await showMainMenu(sid, msgId); return; }
      menu.ctx.taskText = text;
      menu.state = M.NEW_CONFIRM;
      await confirmNewSession(sid, menu.ctx.workspace, text, msgId);
      return;

    case M.NEW_CONFIRM:
      if (num === 0) { menu.state = M.MAIN; await showMainMenu(sid, msgId); return; }
      if (num === 1) { await doCreateAndRun(sid, menu.ctx.workspace, menu.ctx.taskText, msgId); return; }
      sendReply(sid, '⚠️ 回复 1 确认，0 取消'); sendResponse(msgId, { stopReason: 'end_turn' });
      return;
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

/* ───────── Menu Renderers ───────── */

async function showMainMenu(sid, msgId) {
  const busy = await getCurrentTaskInfo(sid);
  const buf = [
    '🤖 远程编程控制台',
    '──────────────────',
    '1. 📋 会话列表',
    '2. ➕ 新建会话',
    '3. 🔄 切换会话',
    '4. ✏️  重命名会话',
    '5. 🗑️  删除会话',
    '6. 📊 当前任务状态',
    '0. ❌ 退出',
    busy ? `\n⏺ 当前: ${busy.title || '未命名'}` : '',
    '──────────────────',
    '回复编号选择操作',
  ].filter(Boolean).join('\n');
  sendReply(sid, buf);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function showSessionList(sid, msgId) {
  const menu = getMenu(sid);
  try {
    const raw = await apiFetch('/session');
    const list = Array.isArray(raw) ? raw : [];
    const sorted = list.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
    const show = sorted.slice(0, SESSION_MAX_SHOW);
    menu.sessions = show;
    const modeLabel = { view: '查看详情', switch: '切换目标', delete: '删除目标' }[menu.ctx.mode] || '选择';
    const lines = [`📋 会话列表 (${list.length} 个)`];
    lines.push('─'.repeat(20));
    const currentTitle = await getCurrentSessionTitle();
    show.forEach((s, i) => {
      const active = s.id === serverSessionId;
      const mark = active ? '⏺ ' : `${i + 1}. `;
      const name = s.title || '未命名';
      const status = active ? ' ← 当前' : '';
      lines.push(`${mark}${name}${status}`);
    });
    if (show.length === 0) lines.push('（暂无会话）');
    lines.push('─'.repeat(20));
    lines.push(`回复编号${modeLabel}，0 返回`);
    sendReply(sid, lines.join('\n'));
  } catch (err) {
    sendReply(sid, `⚠️ 获取列表失败: ${err.message}`);
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function showSessionDetail(sid, session, msgId) {
  const active = session.id === serverSessionId ? '⏺ 当前会话' : '';
  const lines = [
    `📄 ${session.title || '未命名'}`,
    active,
    `├ ID: ${session.id.slice(0, 20)}...`,
    `├ 目录: ${session.directory || '(默认)'}`,
    `├ 模型: ${session.model?.id || '未知'}`,
    `├ Agent: ${session.agent || '未知'}`,
    `├ Tokens: ${((session.tokens?.input || 0) + (session.tokens?.output || 0)).toLocaleString()}`,
    `├ 创建: ${fmtTime(session.time?.created)}`,
    `└ 更新: ${fmtTime(session.time?.updated)}`,
    '─'.repeat(16),
    '0. 🔙 返回列表',
  ].filter(Boolean).join('\n');
  sendReply(sid, lines);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function showWorkspaceList(sid, msgId) {
  const wsList = loadWorkspaces();
  const lines = ['📂 选择工作区', '─'.repeat(20)];
  wsList.forEach((w, i) => lines.push(`${i + 1}. ${w.name}`));
  lines.push('0. 🔙 取消');
  lines.push('─'.repeat(20));
  lines.push('回复编号选择工作区');
  sendReply(sid, lines.join('\n'));
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function confirmSwitch(sid, session, msgId) {
  const menu = getMenu(sid);
  menu.ctx.targetId = session.id;
  menu.ctx.targetTitle = session.title || '未命名';
  sendReply(sid, `🔄 切换到「${menu.ctx.targetTitle}」？\n1. ✅ 确认\n0. 🔙 取消`);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function confirmDelete(sid, session, msgId) {
  const menu = getMenu(sid);
  menu.ctx.targetId = session.id;
  menu.ctx.targetTitle = session.title || '未命名';
  sendReply(sid, `🗑️  删除「${menu.ctx.targetTitle}」？\n⚠️ 此操作不可恢复！\n1. ✅ 确认删除\n0. 🔙 取消`);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function confirmNewSession(sid, ws, task, msgId) {
  const lines = [
    '📝 确认新建会话',
    '─'.repeat(16),
    `工作区: ${ws.name}`,
    `路径: ${ws.path}`,
    `任务: ${task.length > 60 ? task.slice(0, 60) + '...' : task}`,
    '',
    '1. ✅ 创建并运行',
    '0. 🔙 取消',
  ].join('\n');
  sendReply(sid, lines);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function showTaskStatus(sid, msgId) {
  try {
    const statusMapRaw = await apiFetch('/session/status');
    const statusMap = statusMapRaw && typeof statusMapRaw === 'object' ? statusMapRaw : {};
    const lines = ['📊 任务状态', '─'.repeat(16)];
    let hasActive = false;
    for (const [id, st] of Object.entries(statusMap)) {
      if (st.type === 'busy') {
        hasActive = true;
        try {
          const info = await apiFetch(`/session/${id}`);
          lines.push(`▶️ ${info.title || '未命名'} — 运行中`);
        } catch {
          lines.push(`▶️ ${id.slice(0, 16)}... — 运行中`);
        }
      }
    }
    if (!hasActive) lines.push('当前无运行中的任务');
    lines.push('─'.repeat(16));
    lines.push('0. 🔙 返回');
    sendReply(sid, lines.join('\n'));
  } catch (err) {
    sendReply(sid, `⚠️ 获取状态失败: ${err.message}`);
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

/* ───────── Session Operations ───────── */

async function doSwitchSession(sid, targetId, msgId) {
  try {
    const data = await apiFetch(`/session/${targetId}`);
    serverSessionId = data.id || targetId;
    saveSession(serverSessionId);
    const name = data.title || '未命名';
    sendReply(sid, `✅ 已切换到「${name}」`);
  } catch (err) {
    sendReply(sid, `⚠️ 切换失败: ${err.message}`);
  }
  resetMenu(sid);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function doDeleteSession(sid, targetId, title, msgId) {
  try {
    await apiFetch(`/session/${targetId}`, { method: 'DELETE' });
    if (serverSessionId === targetId) {
      serverSessionId = null;
      try { writeFileSync(SESSION_FILE, JSON.stringify({})); } catch {}
    }
    sendReply(sid, `🗑️  已删除「${title}」`);
  } catch (err) {
    sendReply(sid, `⚠️ 删除失败: ${err.message}`);
  }
  resetMenu(sid);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function doRenameSession(sid, targetId, newName, msgId) {
  try {
    await apiFetch(`/session/${targetId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: newName }),
      headers: { 'Content-Type': 'application/json' },
    });
    sendReply(sid, `✏️  已重命名为「${newName}」`);
  } catch (err) {
    sendReply(sid, `⚠️ 重命名失败: ${err.message}`);
  }
  resetMenu(sid);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function doCreateAndRun(sid, ws, task, msgId) {
  sendReply(sid, `⏳ 正在工作区「${ws.name}」创建会话...`);
  try {
    const data = await apiFetch('/session', {
      method: 'POST',
      body: JSON.stringify({ title: task.length > 30 ? task.slice(0, 30) + '...' : task, directory: ws.path }),
      headers: { 'Content-Type': 'application/json' },
    });
    const newSid = data.id;
    serverSessionId = newSid;
    saveSession(newSid);
    sendReply(sid, `✅ 会话已创建，正在执行任务...\n📎 ID: ${newSid.slice(0, 16)}...`);

    const promptRes = await fetch(`${SERVER}/session/${newSid}/message`, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: task }] }),
      signal: AbortSignal.timeout(300000),
    });
    if (!promptRes.ok) {
      sendReply(sid, `⚠️ 执行任务失败 (${promptRes.status})`);
      resetMenu(sid);
      sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
    const result = await promptRes.json();
    const formatted = formatReply(result);
    if (formatted) sendReply(sid, formatted);
    else sendReply(sid, '✅ 任务执行完成（无文本输出）');
  } catch (err) {
    sendReply(sid, `⚠️ 操作失败: ${err.message}`);
  }
  resetMenu(sid);
  sendResponse(msgId, { stopReason: 'end_turn' });
}

/* ───────── AI Prompt Forwarding ───────── */

async function forwardToAI(sid, text, msgId) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const res = await fetch(`${SERVER}/session/${sid}/message`, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const errText = await res.text();
      log(`Server error ${res.status}: ${errText}`);
      sendReply(sid, `⚠️ 服务器错误 (${res.status})，请稍后重试`);
      sendResponse(msgId, { stopReason: 'end_turn' });
      return;
    }
    const data = await res.json();
    const formatted = formatReply(data);
    if (formatted) sendReply(sid, formatted);
    sendResponse(msgId, { stopReason: 'end_turn' });
  } catch (err) {
    log(`handlePrompt error: ${err.message}`);
    const isCancel = err.name === 'AbortError';
    sendReply(sid, isCancel ? '⏰ 请求超时，请重试' : `❌ 错误: ${err.message}`);
    sendResponse(msgId, { stopReason: isCancel ? 'max_tokens' : 'error' });
  }
}

/* ───────── Enhanced Reply Formatter ───────── */

function formatReply(data) {
  const parts = data?.parts || [];
  if (!parts.length) return '';

  const blocks = [];
  let reasoningBuf = '';
  let toolCalls = [];
  let textParts = [];
  let stepCount = 0;

  for (const p of parts) {
    if (p.type === 'text' && p.text) {
      textParts.push(p.text);
    } else if (p.type === 'reasoning' && p.text) {
      reasoningBuf += p.text;
    } else if (p.type === 'tool' && p.tool) {
      const t = p.tool;
      const status = t.state?.status === 'success' ? '✅' : t.state?.status === 'failed' || t.state?.status === 'error' ? '❌' : '🔄';
      toolCalls.push({ name: t.tool || t.name || '未知', status, desc: t.state?.metadata?.description || '' });
    } else if (p.type === 'step-start') {
      stepCount++;
    }
  }

  if (reasoningBuf) {
    const short = reasoningBuf.length > 200 ? reasoningBuf.slice(0, 200) + '...' : reasoningBuf;
    blocks.push(`🤔 ${short}`);
  }
  if (toolCalls.length > 0) {
    const toolLines = toolCalls.slice(-8).map(t => `${t.status} ${t.name}${t.desc ? ' — ' + t.desc : ''}`);
    blocks.push('🔧 ' + toolLines.join('\n   '));
  }
  const mainText = textParts.join('\n').trim();
  if (mainText) {
    if (blocks.length) blocks.push('');
    blocks.push(mainText);
  }
  return blocks.join('\n');
}

/* ───────── Workspace Config ───────── */

function loadWorkspaces() {
  try {
    if (existsSync(WORKSPACES_FILE)) {
      const data = JSON.parse(readFileSync(WORKSPACES_FILE, 'utf8'));
      if (Array.isArray(data) && data.length) return data;
    }
  } catch (err) {
    log(`Failed to load workspaces: ${err.message}`);
  }
  const defaults = [
    { name: '主项目', path: WORK_DIR },
  ];
  try {
    writeFileSync(WORKSPACES_FILE, JSON.stringify(defaults, null, 2));
  } catch {}
  return defaults;
}

/* ───────── Helpers ───────── */

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    headers: { Authorization: AUTH, ...opts.headers },
    signal: AbortSignal.timeout(10000),
    ...opts,
  });
  if (!res.ok) {
    let errText;
    try { errText = await res.text(); } catch { errText = res.statusText; }
    throw new Error(`${res.status}: ${errText.slice(0, 200)}`);
  }
  if (opts.method === 'DELETE') return {};
  return res.json();
}

async function getCurrentSessionTitle() {
  if (!serverSessionId) return null;
  try {
    const data = await apiFetch(`/session/${serverSessionId}`);
    return data.title || null;
  } catch { return null; }
}

async function getCurrentTaskInfo(sid) {
  try {
    const statusMap = await apiFetch('/session/status');
    if (!statusMap || typeof statusMap !== 'object') return null;
    const busyId = Object.entries(statusMap).find(([, s]) => s.type === 'busy')?.[0];
    if (!busyId) return null;
    const info = await apiFetch(`/session/${busyId}`);
    return { id: busyId, title: info.title };
  } catch { return null; }
}

function fmtTime(ts) {
  if (!ts) return '未知';
  try { return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return '未知'; }
}

/* ───────── ACP Handlers ───────── */

async function handleNewSession(msg, cwd) {
  try {
    const res = await fetch(`${SERVER}/session`, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'WeChat', directory: cwd || undefined }),
    });
    const data = res.ok ? await res.json() : {};
    const sid = data.id || ('sess_wechat_' + Date.now());
    serverSessionId = sid;
    saveSession(sid);
    log(`Created server session: ${sid}`);
    sendResponse(msg.id, { sessionId: sid, configOptions: [], modes: null, models: null });
  } catch (err) {
    log(`session/new error: ${err.message}`);
    const sid = 'sess_wechat_' + Date.now();
    sendResponse(msg.id, { sessionId: sid, configOptions: [], modes: null, models: null });
  }
}

async function handleListSessions(msg) {
  try {
    const res = await fetch(`${SERVER}/session`, {
      headers: { Authorization: AUTH },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { sendResponse(msg.id, { sessions: [] }); return; }
    const list = await res.json();
    const sessions = (Array.isArray(list) ? list : []).map(s => ({
      sessionId: s.id,
      cwd: s.directory || '',
      title: s.title || '',
      updatedAt: s.time?.updated ? new Date(s.time.updated).toISOString() : undefined,
    }));
    sendResponse(msg.id, { sessions });
  } catch (err) {
    log(`session/list error: ${err.message}`);
    sendResponse(msg.id, { sessions: [] });
  }
}

async function handleLoadSession(msg) {
  const sessionId = msg.params?.sessionId;
  if (!sessionId) { sendResponse(msg.id, { _meta: { error: 'sessionId required' } }); return; }
  try {
    const data = await apiFetch(`/session/${sessionId}`);
    serverSessionId = data.id || sessionId;
    saveSession(serverSessionId);
    log(`Switched to session: ${serverSessionId}`);
    sendResponse(msg.id, {
      sessionId: serverSessionId,
      cwd: data.directory || '',
      title: data.title || '',
      updatedAt: data.time?.updated ? new Date(data.time.updated).toISOString() : undefined,
    });
  } catch (err) {
    log(`session/load error: ${err.message}`);
    sendResponse(msg.id, { _meta: { error: err.message } });
  }
}

async function handleCancel(msg) {
  const sid = msg.params?.sessionId || serverSessionId;
  if (sid) {
    log(`Cancelling session ${sid}`);
    try {
      await fetch(`${SERVER}/session/${sid}/abort`, {
        method: 'POST', headers: { Authorization: AUTH }, signal: AbortSignal.timeout(5000),
      });
    } catch {}
  }
}

function loadSession() {
  try {
    if (existsSync(SESSION_FILE)) {
      const saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
      if (saved.sessionId) { log(`Loaded saved session: ${saved.sessionId}`); return saved.sessionId; }
    }
  } catch {}
  return null;
}

function saveSession(id) {
  try { writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: id })); } catch (err) { log(`Failed to save session: ${err.message}`); }
}

function sendReply(sid, text) {
  sendNotification('session/update', {
    sessionId: sid,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId: uuid() },
  });
}

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
  log(`Response id=${id}: ${msg.slice(0, 120)}`);
}

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(msg + '\n');
  log(`Notification method=${method}: ${msg.slice(0, 120)}`);
}
