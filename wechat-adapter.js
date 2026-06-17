import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execSync, exec } from 'node:child_process';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

const SERVER = process.env.OPENCODE_SERVER || 'http://localhost:4096';
const AUTH = 'Basic ' + Buffer.from(process.env.OPENCODE_AUTH || 'opencode:opencode').toString('base64');
const WORK_DIR = dirname(fileURLToPath(import.meta.url));

let sdkClient = createOpencodeClient({
  baseUrl: SERVER,
  headers: { Authorization: AUTH },
  directory: WORK_DIR,
});
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
let quotaMode = 'truncate'; // truncate | notify | continue
const FILTER_LEVELS = ['full', 'pad', 'phone'];
const QUOTA_MODES = ['truncate', 'notify', 'continue'];
const QUOTA_ALIASES = { t: 'truncate', trunc: 'truncate', n: 'notify', notif: 'notify', c: 'continue', cont: 'continue' };
const FILTER_ALIASES = { f: 'full', p: 'pad', pd: 'pad', ph: 'phone' };
const FILTER_FILE = join(WORK_DIR, '.wechat-filter.json');
function loadFilterLevel() {
  try {
    if (existsSync(FILTER_FILE)) {
      const data = JSON.parse(readFileSync(FILTER_FILE, 'utf8'));
      quotaMode = data.quota || 'truncate';
      return data.level || 'pad';
    }
  } catch {}
  return 'pad';
}
function saveFilterLevel() { try { writeFileSync(FILTER_FILE, JSON.stringify({ level: filterLevel, quota: quotaMode })); } catch (e) { log(`[SAVE] filter level error: ${e.message}`); } }
function isFull() { return filterLevel === 'full'; }
function isPad() { return filterLevel === 'pad'; }
function isPhone() { return filterLevel === 'phone'; }

filterLevel = loadFilterLevel();
let lineBuf = '';
let lineBufOverflowCount = 0;
let subscribers = [];
let sessionStates = new Map();
let pendingNotifications = [];
let pendingPermissions = new Map();
let pendingQuestions = null;
let draining = false;
let pendingTruncated = false;

// Response handling
let lastPromptSid = null;     // last wechat user who sent a prompt
let lastPromptSessionId = null; // last session prompted
let lastPromptText = '';      // last prompt text
let pendingReplyText = '';    // accumulated text parts for question API responses
let responseSent = false;     // true after final reply is sent (prevents double-reply)
let responseForSession = null; // session ID that the pending response is for
let heartbeats = [];           // 心跳定时器 ID 列表
const HEARTBEAT_DELAY_MS = 30000; // 心跳延迟（仅长任务触发）
const QUESTION_AUTO_CLEAR_MS = 7200000; // 2h auto-clear for unanswered questions
const MAX_ACCUMULATED_TEXT = 100000; // SSE 累积最大字符数，超限后截断（需远大于 continuation 截断点 3000）
const NOTIFICATION_RATE_LIMIT_MS = 3000; // 同一用户连续通知最小间隔
const SESSION_MESSAGE_TIMEOUT = 300000; // 会话消息 POST 超时（5分钟）
const REALTIME_FLUSH_MS = 3000; // FULL 模式实时流式刷出间隔 (ms)
const REALTIME_MIN_FLUSH = 3500; // FULL 模式最小累积字符数后立即刷出（每个 context_token 约 5 次 API 调用上限）
let pendingQuestionQueue = []; // queue for question.asked events that arrive while one is pending
let realtimeBuffer = '';       // FULL 模式实时文本缓冲
let realtimeFlushTimer = null; // 实时刷出定时器
let toolStates = new Map();    // partId -> { tool, input, startTime } 工具状态跟踪
let processingNotified = false; // PAD/PHONE 是否已发送首个处理通知
let currentTextMessageId = null; // 当前回复的持久 messageId，所有文本块合并为一条微信消息
let fullQuotaUsed = 0;          // FULL 模式当前 turn 已使用的 sendmessage 调用次数
let pendingContinuation = null; // { sid, messages[], total } - continue 模式消息队列
let continuationNotified = false; // 防止「回复过长已保存」在多个处理器中重复发送
let idleHandled = false; // 防止 session.idle 和 session.status.idle 双重处理
const FULL_QUOTA_LIMIT = 4;     // 每 context_token 最多 5 次，预留 1 次给结束 flush
const MAX_REALTIME_BUFFER = 3000; // FULL 模式实时缓冲上限，确保 end-of-turn 最多 1 段 (TEXT_CHUNK_LIMIT=4000)
const MIN_CONTINUATION_LENGTH = 10; // 续存文本最小长度，低于此值跳过续存直接截断
let sseReadTimer = null;       // SSE 读取超时定时器
let sseConnectionActive = false; // SSE 连接活跃标记
let sseRestarting = false;       // 防止并发重启 SSE

/* ───────── Stdout Write Queue (backpressure-safe) ───────── */

const stdoutQueue = [];
let stdoutDraining = false;
const STDOUT_WARN_THRESHOLD = 200;
const STDOUT_QUEUE_LIMIT = 500;
const STDOUT_DROP_BATCH = 100;

let stdoutDropLogged = new Set();

function writeStdout(msg) {
  if (stdoutQueue.length >= STDOUT_QUEUE_LIMIT + STDOUT_DROP_BATCH) {
    const dropped = stdoutQueue.splice(0, stdoutQueue.length - STDOUT_QUEUE_LIMIT);
    const isResponse = /"jsonrpc"\s*:\s*"2\.0"\s*,\s*"id"\s*:/.test(msg);
    if (isResponse) {
      stdoutQueue.push(msg);
      log(`[WARN] stdout queue overflow, preserved response, dropped ${dropped.length} notifications`);
      if (!stdoutDraining) processStdoutQueue();
      return;
    }
    log(`[WARN] stdout queue overflow: dropped ${dropped.length} oldest messages`);
  } else if (stdoutQueue.length >= STDOUT_WARN_THRESHOLD && !stdoutDropLogged.has(Math.floor(stdoutQueue.length / 50))) {
    stdoutDropLogged.add(Math.floor(stdoutQueue.length / 50));
    log(`[WARN] stdout queue growing: ${stdoutQueue.length} items`);
  }
  stdoutQueue.push(msg);
  if (!stdoutDraining) processStdoutQueue();
}

function processStdoutQueue() {
  if (stdoutDraining) return;
  stdoutDraining = true;
  let writeCount = 0;
  while (stdoutQueue.length > 0) {
    const msg = stdoutQueue[0];
    const canContinue = process.stdout.write(msg);
    if (!canContinue) {
      process.stdout.once('drain', () => {
        stdoutDraining = false;
        processStdoutQueue();
      });
      return;
    }
    stdoutQueue.shift();
    writeCount++;
    if (writeCount >= 100) {
      setImmediate(() => {
        stdoutDraining = false;
        processStdoutQueue();
      });
      return;
    }
  }
  stdoutDraining = false;
}

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
    if (lineBuf.length > 65536) {
      lineBufOverflowCount++;
      log(`[WARN] lineBuf overflow #${lineBufOverflowCount}, clearing (size=${lineBuf.length})`);
      lineBuf = '';
    }
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

    if (pendingQuestions && !text.startsWith('/')) {
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
    pendingTruncated = false;
    processingNotified = false;
    responseSent = false;
    responseForSession = targetId;
    currentTextMessageId = uuid();
    idleNotified.delete(targetId); // allow fresh idle events for this session
    armHeartbeat(sid);

    reply(sid, '⏳ 思考中...');
    sendResponse(msg.id, { stopReason: 'end_turn' });
    pendingContinuation = null; // clear only when actually sending to AI, not for /g /x
    continuationNotified = false;
    idleHandled = false;
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
    case '/quota': case '/q':
      return handleQuotaMode(sid, arg, msgId);
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
    case '/g': case '/get': case '/cont':
      return handleContinue(sid, msgId);
    case '/x': case '/gc':
      return handleClearContinue(sid, msgId);
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
    const { data } = await sdkClient.session.list({ directory: d, limit: 100 }).catch(() => ({ data: null }));
    if (data && Array.isArray(data) && data.length > 0) {
      return data;
    }
  }
  const { data: fallback } = await sdkClient.session.list({ limit: 100 }).catch(() => ({ data: [] }));
  const list = Array.isArray(fallback) ? fallback : [];
  if (list.length > 0) {
    const dirLower = dir.toLowerCase();
    return list.filter(s => s.directory && s.directory.toLowerCase().startsWith(dirLower));
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
      const { data } = await sdkClient.session.list({ limit: 100 }).catch(() => ({ data: [] }));
      sessions = Array.isArray(data) ? data : [];
    } else {
      sessions = await getWorkspaceSessions();
      if (!Array.isArray(sessions)) sessions = [];
    }

    let currentInList = sessions.some(s => s.id === currentSessionId);
    if (!currentInList && currentSessionId) {
      try {
        const { data: cur } = await sdkClient.session.get({ sessionID: currentSessionId }).catch(() => ({ data: null }));
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

    const { data: statusMap } = await sdkClient.session.status().catch(() => ({ data: {} }));
    const busyIds = new Set(
      Object.entries(statusMap || {})
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
  pendingTruncated = false;
  processingNotified = false;
  responseSent = true;
  responseForSession = null;
  lastPromptSessionId = null;
  lastPromptSid = null;
  currentTextMessageId = null;
  realtimeBuffer = '';
  fullQuotaUsed = 0;
  pendingContinuation = null;
  if (realtimeFlushTimer) { clearTimeout(realtimeFlushTimer); realtimeFlushTimer = null; }
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
    const { data } = await sdkClient.session.get({ sessionID: arg });
    currentSessionId = data?.id || arg;
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
  pendingTruncated = false;
  processingNotified = false;
  responseSent = true;
  responseForSession = null;
  lastPromptSessionId = null;
  lastPromptSid = null;
  currentTextMessageId = null;
  realtimeBuffer = '';
  fullQuotaUsed = 0;
  pendingContinuation = null;
  if (realtimeFlushTimer) { clearTimeout(realtimeFlushTimer); realtimeFlushTimer = null; }
  const target = currentSessionId;
  if (!target) {
    reply(sid, '⚠️ 没有选中的会话');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  try {
    await sdkClient.session.abort({ sessionID: target });
    reply(sid, '⏹️ 已发送取消请求');
  } catch {
    reply(sid, '⚠️ 取消失败');
  }
  sendResponse(msgId, { stopReason: 'end_turn' });
}

async function newSession(sid, title, msgId) {
  disarmWorkingNotice();
  pendingReplyText = '';
  pendingTruncated = false;
  processingNotified = false;
  responseSent = true;
  responseForSession = null;
  lastPromptSessionId = null;
  lastPromptSid = null;
  currentTextMessageId = null;
  realtimeBuffer = '';
  pendingContinuation = null;
  if (realtimeFlushTimer) { clearTimeout(realtimeFlushTimer); realtimeFlushTimer = null; }
  if (!title) {
    reply(sid, '用法: /new <会话名>\n示例: /new 修复登录bug');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  try {
    const dir = getWorkspaceDir();
    const { data: session } = await sdkClient.session.create({ directory: dir, title: title.trim() });
    currentSessionId = (session?.id || 'sess_' + Date.now());
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
    lines.push('/level (/lvl) [f|p|ph]  设置级别，/f /pd /ph 快捷切换');
    lines.push('');
    lines.push('⚠️ FULL 模式：实时推送每个文本/工具增量，每次推送消耗一次 iLink API 调用。');
    lines.push('   长文本时调用频繁，触发微信限流后后续消息静默丢失（用户无法感知回复不完整）。');
    lines.push('   推荐使用 PAD 模式（默认），或通过 OpenCode Web UI');
    lines.push('   (http://localhost:4096) 查看完整输出。');
    reply(sid, lines.join('\n'));
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  const level = arg.trim().toLowerCase();
  const resolved = FILTER_ALIASES[level] || level;
  if (!FILTER_LEVELS.includes(resolved)) {
    reply(sid, `⚠️ 无效级别: ${level}，可选: ${FILTER_LEVELS.join(', ')}, 别名: f, p/pd, ph`);
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  await setFilterLevel(sid, resolved, msgId);
}

async function setFilterLevel(sid, level, msgId) {
  filterLevel = level;
  saveFilterLevel();
  let msg = `${levelIcon(level)} 已切换到 ${level.toUpperCase()} 模式\n${levelDesc(level)}`;
  if (level === 'full') {
    msg += '\n\n⚠️ FULL 模式：实时推送每个文本/工具增量，每次推送消耗一次 iLink API 调用。长文本时调用频繁，触发微信限流后后续消息静默丢失（用户无法感知回复不完整）。推荐使用 PAD 模式（默认），或通过 OpenCode Web UI (http://localhost:4096) 查看完整输出。';
  }
  reply(sid, msg);
  if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
}

function levelIcon(lv) {
  return { full: '📡', pad: '📱', phone: '📟' }[lv] || '🔍';
}
function levelDesc(lv) {
  return {
    full: '实时流式输出 ⚠️ 高频推送触发限流时后半段静默丢失，不推荐日常使用',
    pad: '处理中显示等待提示，仅发送 AI 文本回复',
    phone: '极简模式，仅显示 AI 文本回复和 🤔 处理提示',
  }[lv] || '';
}
function levelLabel(lv) {
  return { full: '📡 FULL 完整模式', pad: '📱 PAD 标准模式', phone: '📟 PHONE 极简模式' }[lv] || lv;
}

const QUOTA_LABELS = {
  truncate: '🔇 静默截断 — 超限部分直接丢弃，不通知用户',
  notify: '🔔 截断通知 — 超限时通知用户回复被截断',
  continue: '📬 继续模式 — 保存超限文本，发 /g 自动续发',
};
function quotaModeLabel(m) { return QUOTA_LABELS[m] || m; }

async function handleQuotaMode(sid, arg, msgId) {
  if (!arg) {
    const lines = ['🔢 超长回复策略'];
    lines.push(`当前: ${quotaModeLabel(quotaMode)}`);
    lines.push('─'.repeat(14));
    for (const m of QUOTA_MODES) {
      const mark = m === quotaMode ? ' ◀' : '';
      lines.push(`${quotaModeLabel(m)}${mark}`);
    }
    lines.push('─'.repeat(14));
    lines.push('/quota (/q) [策略]  设置策略: truncate/notify/continue, 别名: t/trunc, n/notif, c/cont');
    lines.push('');
    lines.push('由于 iLink API 每次 context_token 仅有约 5 次 sendmessage 调用配额，');
    lines.push('长回复会自动截断。continue 模式让用户发 /g 继续接收剩余内容。');
    reply(sid, lines.join('\n'));
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  const mode = arg.trim().toLowerCase();
  const resolved = QUOTA_ALIASES[mode] || mode;
  if (!QUOTA_MODES.includes(resolved)) {
    reply(sid, `⚠️ 无效策略: ${mode}，可选: ${QUOTA_MODES.join(', ')}, 别名: t/trunc, n/notif, c/cont`);
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  quotaMode = resolved;
  saveFilterLevel();
  reply(sid, `✅ 已切换超长回复策略: ${quotaModeLabel(mode)}`);
  if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
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
  await syncPermissionsFromServer();
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
    await sdkClient.permission.reply({ requestID: targetRid, reply: action, message: `via wechat-adapter (sid=${sid.slice(0,12)})` });
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
    const { data: raw } = await sdkClient.permission.list();
    const list = Array.isArray(raw) ? raw : [];
    log(`[SYNC] server returned ${list.length} items`);
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
  try {
    const { data: permRaw } = await sdkClient.permission.list();
    const permList = Array.isArray(permRaw) ? permRaw : [];
    const serverPermIds = new Set(permList.map(r => r.id));
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
    const { data: qAll } = await sdkClient.question.list();
    const qList = Array.isArray(qAll) ? qAll : [];
    const validIds = new Set(qList.map(r => r.id));
    for (const q2 of allQuestions) {
      if (q2.requestID && !validIds.has(q2.requestID)) {
        log(`[SYNC] removing local question rid=${q2.requestID.slice(0,16)}... (not on server)`);
        if (pendingQuestions?.requestID === q2.requestID) {
          clearCurrentQuestion();
        } else {
          const qIdx = pendingQuestionQueue.findIndex(q => q.requestID === q2.requestID);
          if (qIdx >= 0) { clearQuestionTimer(pendingQuestionQueue[qIdx]); pendingQuestionQueue.splice(qIdx, 1); }
        }
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
  pendingTruncated = false;
  processingNotified = false;
  responseSent = true;
  responseForSession = null;
  lastPromptSessionId = null;
  lastPromptSid = null;
  currentTextMessageId = null;
  realtimeBuffer = '';
  fullQuotaUsed = 0;
  pendingContinuation = null;
  if (realtimeFlushTimer) { clearTimeout(realtimeFlushTimer); realtimeFlushTimer = null; }
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

async function discoverWorkspacesViaDbAsync() {
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      exec(
        'opencode db "SELECT id, worktree, sandboxes FROM project WHERE id != \'global\'" --format json',
        { encoding: 'utf8', timeout: 15000 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve({ stdout });
        }
      );
    });
    const projects = JSON.parse(stdout.trim());
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
    log(`[SD] async db query failed: ${err.message}`);
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

    const dbDirs = await discoverWorkspacesViaDbAsync();
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
      const { data: projects } = await sdkClient.project.list().catch(() => ({ data: [] }));
      if (Array.isArray(projects) && projects.length > 0) {
        for (const p of projects) {
          try {
            const { data: dirs } = await sdkClient.project.directories({ projectID: p.id });
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
        const { data: sessions } = await sdkClient.session.list({ limit: 100 }).catch(() => ({ data: [] }));
        const sessionsList = Array.isArray(sessions) ? sessions : [];
        if (sessionsList.length > 0) {
          const dirs = [...new Set(sessionsList.map(s => s.directory).filter(Boolean))];
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
    const { data: statusMap } = await sdkClient.session.status();
    const lines = ['📊 任务状态', '─'.repeat(14)];
    let hasActive = false;
    for (const [id, st] of Object.entries(statusMap || {})) {
      if (st.type === 'busy') {
        hasActive = true;
        const { data: sessionInfo } = await sdkClient.session.get({ sessionID: id }).catch(() => ({ data: null }));
        const name = sessionInfo?.title || id.slice(0, 16);
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

async function handleContinue(sid, msgId) {
  if (!pendingContinuation || !pendingContinuation.messages?.length) {
    reply(sid, '📭 没有待续发的内容');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  const cont = pendingContinuation;
  if (!cont.sid) {
    pendingContinuation = null;
    reply(sid, '⚠️ 续发内容无效，已清除');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  const msg = cont.messages.shift();
  const remaining = cont.messages.length;
  const done = cont.total - remaining;

  log(`[CONT] dequeue ${done}/${cont.total}: ${msg.length} chars, ${remaining} remaining`);
  reply(cont.sid, msg);
  flushToWeChat(cont.sid);

  if (remaining > 0) {
    const progress = sid === cont.sid
      ? `📬 发 /g 继续（${done}/${cont.total}，剩余 ${remaining} 条）`
      : `📬 请查看原对话并发 /g 继续（${done}/${cont.total}，剩余 ${remaining} 条）`;
    reply(sid, progress);
    flushToWeChat(sid);
  } else {
    pendingContinuation = null;
    reply(sid, `✅ 续发完毕（共 ${cont.total} 条）`);
    flushToWeChat(sid);
  }
  if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
}

function splitContinuationMessages(text, sid) {
  const messages = [];
  for (let i = 0; i < text.length; i += MAX_REPLY_LENGTH) {
    messages.push(text.slice(i, i + MAX_REPLY_LENGTH));
  }
  return { sid, messages, total: messages.length };
}

async function handleClearContinue(sid, msgId) {
  if (!pendingContinuation) {
    reply(sid, '📭 没有待续发的内容');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  log(`[CONT] cleared ${pendingContinuation.total} messages (${pendingContinuation.messages.reduce((s, m) => s + m.length, 0)} chars)`);
  pendingContinuation = null;
  reply(sid, '🗑️ 已清除待续发内容');
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
    `/level (/lvl) [f|p|ph]  查看/设置过滤级别 (当前: ${filterLevel.toUpperCase()})`,
    '/f                       切换到 FULL 模式（全部显示）',
    '/pd                      切换到 PAD 模式（摘要显示）',
    '/ph                      切换到 PHONE 模式（极简显示）',
    '/quota (/q) [t|n|c]      查看/设置超长回复策略 (t:截断 n:通知 c:续传)',
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
    '/g (/get, /cont)        继续发送超长回复的剩余内容',
    '/x (/gc)                清除待续发内容',
    '/mute (/m)              开关主动通知',
    '/notify (/n)            查看通知状态与订阅信息',
    '/autoclean (/ac) [天数] 设置不活跃订阅自动清理天数',
    '/testnotify             发送测试通知（调试用）',
    '/help (/h)              显示此帮助',
    '',
    '💡 通知消息中可直接回复答案或权限审批，无需输入命令',
    '💡 未识别的消息将转发给当前选中的 AI 会话',
    '',
    '⚠️ FULL 模式 ( /f ) 实时推送增量，每个 context_token 约 5 次调用上限。',
    '   超限时自动截断+通知，详见 docs/rate-limiting.md。',
    '   推荐 PAD 模式 ( /pd ) 或 OpenCode Web UI (http://localhost:4096)。',
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
  const qArr = pendingQuestionQueue.splice(queueIdx, 1);
  const target = qArr[0];
  clearQuestionTimer(target);
  if (!target) {
    reply(sid, '⚠️ 该问题不存在');
    sendResponse(msgId, { stopReason: 'end_turn' });
    return;
  }
  // Push current back to queue head (clear its timer first)
  if (pendingQuestions) {
    clearQuestionTimer(pendingQuestions);
    pendingQuestionQueue.unshift(pendingQuestions);
  }
  pendingQuestions = target;
  if (target.sessionID) currentSessionId = target.sessionID;
  const ts = Date.now();
  target.askTimestamp = ts;
  const autoClear = setTimeout(() => {
    if (pendingQuestions?.askTimestamp === ts) { clearCurrentQuestion(); dequeueNextQuestion(); }
  }, QUESTION_AUTO_CLEAR_MS);
  autoClear.unref?.();
  target._autoClearTimer = autoClear;
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
    const autoClear = setTimeout(() => {
      if (pendingQuestions?.askTimestamp === ts) { clearCurrentQuestion(); dequeueNextQuestion(); }
    }, QUESTION_AUTO_CLEAR_MS);
    autoClear.unref?.();
    qData._autoClearTimer = autoClear;
  }

  const targetId = currentSessionId;

  // If we have a requestID (question API), session check is optional — the API binds to the question's session
  if (!qData.requestID) {
    if (!targetId) {
      reply(sid, '⚠️ 没有选中的会话，无法提交答案');
      if (msgId != null) sendResponse(msgId, { stopReason: 'end_turn' });
      clearCurrentQuestion();
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
    if (pendingQuestions?.questions?.[0]) {
      return listCurrentQuestion(sid, msgId);
    }
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
  clearCurrentQuestion();
  await dequeueNextQuestion();
  log(`[ANSWER] sid=${sid.slice(0,12)} answers=[${combined}]`);
  lastPromptSid = sid;
  lastPromptSessionId = qData.sessionID || targetId;
  lastPromptText = combined;
  currentTextMessageId = uuid();
  disarmWorkingNotice();
  pendingReplyText = '';
  pendingTruncated = false;
  processingNotified = false;
  pendingContinuation = null;
  responseSent = false;
  responseForSession = qData.sessionID || targetId;
  idleNotified.delete(qData.sessionID || targetId);
  armHeartbeat(sid);
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
    const result = await sdkClient.question.reply({ requestID, answers: answers.map(a => [a]) });
    if (result.error) {
      disarmWorkingNotice();
      responseSent = true;
      responseForSession = null;
      pendingReplyText = '';
      pendingTruncated = false;
      processingNotified = false;
      pendingContinuation = null;
      reply(sid, `⚠️ 回答提交失败: ${(result.error?.data?.message || result.error?.message || 'unknown').slice(0, 100)}`);
      await drainPendingNotifications();
      flushToWeChat();
      return;
    }
    log(`[ANSWER] reply sent via question API, waiting for SSE response...`);
  } catch (err) {
    disarmWorkingNotice();
    responseSent = true;
    responseForSession = null;
    pendingReplyText = '';
    pendingTruncated = false;
    processingNotified = false;
    pendingContinuation = null;
    reply(sid, `❌ 回答提交失败: ${err.message}`);
    await drainPendingNotifications();
    flushToWeChat();
  }
}

function clearQuestionTimer(q) {
  if (q?._autoClearTimer) { clearTimeout(q._autoClearTimer); q._autoClearTimer = null; }
}
function clearCurrentQuestion() {
  clearQuestionTimer(pendingQuestions);
  pendingQuestions = null;
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
    next._autoClearTimer = autoClear;
    await fetchSessionName(next.sessionID);
    const sesLabel = next.sessionID ? `[${getSessionName(next.sessionID)}] ` : '';
    const qi = next.questions?.[0];
    if (!qi) { clearTimeout(autoClear); pendingQuestions = null; continue; }
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
      clearCurrentQuestion();
      await dequeueNextQuestion();
    } else {
      const arr = pendingQuestionQueue.splice(qIdx - 1, 1);
      qData = arr[0];
      clearQuestionTimer(qData);
    }
  } else {
    const arr = pendingQuestionQueue.splice(qIdx, 1);
    qData = arr[0];
    clearQuestionTimer(qData);
  }

  const requestID = qData?.requestID;
  const qSessID = qData?.sessionID;
  if (requestID && qSessID) {
    try {
      await sdkClient.question.reject({ requestID });
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

/* ───────── Heartbeat ───────── */

function armHeartbeat(sid) {
  disarmWorkingNotice();
  const msg = isFull()
    ? '⏳ AI正在处理中…'
    : isPhone()
      ? '⏳ AI正在思考…'
      : '⏳ AI正在处理中…';
  const t = setTimeout(() => {
    if (responseSent) return;
    reply(sid, msg);
    flushToWeChat();
  }, HEARTBEAT_DELAY_MS);
  t.unref?.();
  heartbeats = [t];
}

function disarmWorkingNotice() {
  for (const t of heartbeats) {
    clearTimeout(t);
  }
  heartbeats = [];
}

/* ───────── AI Prompt Forwarding ───────── */

async function forwardToAIAsync(sid, targetId, text) {
  fullQuotaUsed = 0;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SESSION_MESSAGE_TIMEOUT);
    let promptResult;
    try {
      promptResult = await sdkClient.session.prompt({
        sessionID: targetId,
        parts: [{ type: 'text', text }],
        agent: currentAgent,
      }, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (promptResult.error) {
      disarmWorkingNotice();
      const errMsg = promptResult.error?.message || promptResult.error?.data?.message || '';
      if (/abort/i.test(errMsg)) {
        // SDK wraps AbortError in response.error — treat as timeout
        if (responseSent) { return; }
        const accumulated = pendingReplyText.trim();
        pendingReplyText = '';
        pendingTruncated = false;
        fullQuotaUsed = 0;
        processingNotified = false;
        pendingContinuation = null;
        responseSent = true;
        responseForSession = null;
        lastPromptSessionId = null;
        lastPromptSid = null;
        currentTextMessageId = null;
        realtimeBuffer = '';
        fullQuotaUsed = 0;
        if (realtimeFlushTimer) { clearTimeout(realtimeFlushTimer); realtimeFlushTimer = null; }
        idleNotified.add(targetId);
        reply(sid, accumulated ? `🤖 ${accumulated}` : '⏰ 请求超时，请重试');
      } else {
        responseSent = true;
        responseForSession = targetId;
        reply(sid, `⚠️ 服务器错误: ${errMsg.slice(0, 100)}`);
      }
      await drainPendingNotifications();
      flushToWeChat();
      return;
    }

    const data = promptResult.data;
    await drainPendingNotifications();
    // Notifications need a flush to reach WeChat even if forwardToAIAsync returns early (FULL mode)
    flushToWeChat();
    if (responseSent && responseForSession === targetId) {
      log(`[FWD] response already sent for ${sid.slice(0,12)}, skipping`);
      return;
    }
    if (responseForSession !== targetId) {
      disarmWorkingNotice();
      log(`[FWD] stale response for session ${targetId?.slice(0,12)}, expected ${responseForSession?.slice(0,12)}, sending completion only`);
      if (!idleNotified.has(targetId)) {
        idleNotified.add(targetId);
        await fetchSessionName(targetId);
        const compName = getSessionName(targetId);
        const sendSid = lastPromptSid || sid;
        if (sendSid) {
          reply(sendSid, `✅ ${compName} · 完成`);
          sendNotification('session/update', {
            sessionId: sendSid,
            update: {
              sessionUpdate: 'tool_call',
              title: 'notification',
              toolCallId: uuid(),
              kind: 'other',
              status: 'completed',
            },
          });
        }
      }
      return;
    }
    responseSent = true;
    disarmWorkingNotice();
    const accumulated = pendingReplyText.trim();
    pendingReplyText = '';
    pendingTruncated = false;
    // FULL mode: flush remaining buffered text, then flush to wechat
    // Note: in practice forwardToAIAsync returns early in FULL mode
    // because session.idle fires first and sets responseSent.
    // This block is a fallback for edge cases.
    if (isFull()) {
      if (realtimeBuffer && lastPromptSid) {
        let text = realtimeBuffer;
        if (text.length > MAX_REALTIME_BUFFER) {
          if (quotaMode === 'continue') {
            if (text.slice(MAX_REALTIME_BUFFER).length >= MIN_CONTINUATION_LENGTH) {
              pendingContinuation = splitContinuationMessages(text.slice(MAX_REALTIME_BUFFER), lastPromptSid);
              text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（剩余内容请发 /g 继续获取）';
            } else {
              text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（回复已截断，超出上限）';
            }
          } else if (quotaMode === 'notify') {
            text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（回复已截断，超出上限）';
          } else {
            text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（内容过长，请在 OpenCode 界面查看完整输出）';
          }
        }
        realtimeBuffer = '';
        fullQuotaUsed++;
        reply(lastPromptSid, text, currentTextMessageId);
      }
      flushToWeChat();
      if (pendingContinuation && !continuationNotified) {
        continuationNotified = true;
        reply(pendingContinuation.sid, `📬 回复过长已保存，发 /g 继续接收（共 ${pendingContinuation.total} 条）`);
        flushToWeChat();
      }
      fullQuotaUsed = 0;
    } else if (accumulated) {
      let text = accumulated;
      if (quotaMode === 'continue' && text.length > MAX_REALTIME_BUFFER) {
        if (text.slice(MAX_REALTIME_BUFFER).length >= MIN_CONTINUATION_LENGTH) {
          pendingContinuation = splitContinuationMessages(text.slice(MAX_REALTIME_BUFFER), sid);
          text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（剩余内容请发 /g 继续获取）';
        } else {
          text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（回复已截断，超出上限）';
        }
      } else if (quotaMode === 'notify' && text.length > MAX_REALTIME_BUFFER) {
        text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（回复已截断，超出上限）';
      } else if (text.length > MAX_REALTIME_BUFFER) {
        text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（内容过长，请在 OpenCode 界面查看完整输出）';
      }
      reply(sid, `🤖 ${text}`);
      flushToWeChat();
      if (pendingContinuation && !continuationNotified) {
        continuationNotified = true;
        reply(pendingContinuation.sid, `📬 回复过长已保存，发 /g 继续接收（共 ${pendingContinuation.total} 条）`);
        flushToWeChat();
      }
    } else {
      const formatted = formatReply(data);
      if (formatted) {
        reply(sid, formatted);
        flushToWeChat();
      }
    }
    // Send session completion notification immediately
    if (!idleNotified.has(targetId)) {
      await fetchSessionName(targetId);
      const compName = getSessionName(targetId);
      idleNotified.add(targetId);
      const sendSid = lastPromptSid || sid;
      if (sendSid) {
        reply(sendSid, `✅ ${compName} · 完成`);
        sendNotification('session/update', {
          sessionId: sendSid,
          update: {
            sessionUpdate: 'tool_call',
            title: 'notification',
            toolCallId: uuid(),
            kind: 'other',
            status: 'completed',
          },
        });
      }
    }
  } catch (err) {
    disarmWorkingNotice();
    if (responseForSession !== targetId) return; // superseded by newer prompt
    if (err.name === 'AbortError') {
      if (responseSent) return; // session.idle already sent text, avoid duplicate
      const accumulated = pendingReplyText.trim();
      log(`[FWD] timeout: lastSid=${(lastPromptSessionId||'?').slice(0,12)} targetId=${(targetId||'?').slice(0,12)} text_len=${text.length} pending_len=${pendingReplyText.length} accumulated_len=${accumulated.length}`);
      pendingReplyText = '';
      pendingTruncated = false;
      processingNotified = false;
      pendingContinuation = null;
      responseSent = true;
      responseForSession = null;
      lastPromptSessionId = null;
      lastPromptSid = null;
      currentTextMessageId = null;
      realtimeBuffer = '';
      fullQuotaUsed = 0;
      if (realtimeFlushTimer) { clearTimeout(realtimeFlushTimer); realtimeFlushTimer = null; }
      idleNotified.add(targetId);
      if (accumulated) {
        reply(sid, `🤖 ${accumulated}`);
      } else {
        reply(sid, '⏰ 请求超时，请重试');
      }
    } else {
      pendingReplyText = '';
      pendingTruncated = false;
      processingNotified = false;
      pendingContinuation = null;
      responseSent = true;
      responseForSession = null;
      lastPromptSessionId = null;
      lastPromptSid = null;
      currentTextMessageId = null;
      realtimeBuffer = '';
      fullQuotaUsed = 0;
      if (realtimeFlushTimer) { clearTimeout(realtimeFlushTimer); realtimeFlushTimer = null; }
      reply(sid, `❌ ${err.message}`);
    }
    await drainPendingNotifications();
    flushToWeChat();
    fullQuotaUsed = 0;
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
  sendResponse(msg.id, { sessionId: 'acp_' + uuid(), configOptions: [], modes: null, models: null });
}

async function handleListSessions(msg) {
  try {
    const { data: list } = await sdkClient.session.list({ limit: 100 });
    const arr = Array.isArray(list) ? list : [];
    const sessions = arr.map(s => ({
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
    const { data } = await sdkClient.session.get({ sessionID: sessionId });
    currentSessionId = data?.id || sessionId;
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
    try { await sdkClient.session.abort({ sessionID: id }); } catch {}
  }
  disarmWorkingNotice();
  pendingReplyText = '';
  pendingTruncated = false;
  processingNotified = false;
  responseSent = true;
  responseForSession = null;
  lastPromptSessionId = null;
  lastPromptSid = null;
  currentTextMessageId = null;
  realtimeBuffer = '';
  fullQuotaUsed = 0;
  pendingContinuation = null;
  if (realtimeFlushTimer) { clearTimeout(realtimeFlushTimer); realtimeFlushTimer = null; }
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
  } catch (e) { log(`[LOAD] workspaces parse error: ${e.message}`); }
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
  } catch (e) { log(`[LOAD] default workspace error: ${e.message}`); }
  return list[0];
}

function saveCurrentWorkspace() {
  try { writeFileSync(WORKSPACE_CURRENT_FILE, JSON.stringify({ path: currentWorkspace.path })); } catch (e) { log(`[SAVE] current workspace error: ${e.message}`); }
}

function getWorkspaceDir() {
  return currentWorkspace?.path || WORK_DIR;
}
function updateClientDirectory() {
  try {
    sdkClient.client.setConfig({
      headers: Object.assign(sdkClient.client.getConfig().headers || {}, {
        'x-opencode-directory': encodeURIComponent(getWorkspaceDir()),
      }),
    });
  } catch (e) { log(`[SDK] updateClientDirectory error: ${e.message}`); }
}

function saveWorkspaces(list) {
  try { writeFileSync(WORKSPACES_FILE, JSON.stringify(list, null, 2)); } catch (e) { log(`[SAVE] workspaces error: ${e.message}`); }
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
  try { writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: id })); } catch (e) { log(`[SAVE] session error: ${e.message}`); }
}

/* ───────── Subscribers ───────── */

function loadSubscribers() {
  try { if (existsSync(SUBSCRIBERS_FILE)) subscribers = JSON.parse(readFileSync(SUBSCRIBERS_FILE, 'utf8')); } catch (e) { log(`[LOAD] subscribers parse error: ${e.message}`); }
  if (!Array.isArray(subscribers)) subscribers = [];
}
function saveSubscribers() {
  try { writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subscribers, null, 2)); } catch (e) { log(`[SAVE] subscribers error: ${e.message}`); }
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

const MAX_REPLY_LENGTH = 4000;

function reply(sid, text, msgId) {
  if (!sid) { log(`[REPLY] SKIP: null sid`); return; }
  const messageId = msgId || uuid();
  log(`[REPLY] to=${sid.slice(0,12)} len=${text.length} msgId=${messageId.slice(0,12)} text=${text.slice(0,80).replace(/\n/g,'\\n')}`);
  if (text.length <= MAX_REPLY_LENGTH) {
    sendNotification('session/update', {
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId },
    });
    return;
  }
  for (let i = 0; i < text.length; i += MAX_REPLY_LENGTH) {
    const chunk = text.slice(i, i + MAX_REPLY_LENGTH);
    sendNotification('session/update', {
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk }, messageId },
    });
  }
}

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
  writeStdout(msg);
  log(`→ response id=${id} ok${result._meta?.error ? ' ERR=' + result._meta.error : ''}`);
}

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
  writeStdout(msg);
  log(`→ notify ${method} ${params.sessionId ? 'sid='+params.sessionId.slice(0,12) : ''} ${params.update?.sessionUpdate || ''} ${params.update?.content?.type || ''}`);
}

/* ═══════════════════════════════════════
   Notification System — SSE Event Monitor
   ═══════════════════════════════════════ */

let sessionNames = new Map(); // id -> { name, ts }
const SESSION_NAME_TTL = 300000; // 5 min
let idleNotified = new Set();
let recentNotifications = new Map(); // text → timestamp, dedup within 60s
let perUserRecent = new Map(); // sid → { text → timestamp }
let proactiveTimer = null;
let recentEventIds = new Set(); // event ID → timestamp, dedup within 10s
let lastNotifyPerSid = new Map(); // sid → timestamp, notification rate limiting
let sseReader = null;          // current SSE reader (for restart on workspace change)

const DEDUP_WINDOW = 30000;
const PER_USER_DEDUP_WINDOW = 30000;

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
  // Clean old global entries (every 50 writes)
  if (recentNotifications.size > 50) {
    const cutoff = now - DEDUP_WINDOW * 2;
    let removed = 0;
    for (const [t, ts] of recentNotifications) {
      if (ts < cutoff) { recentNotifications.delete(t); removed++; }
    }
    if (removed > 0) log(`[BROADCAST] cleaned ${removed} old dedup entries (${recentNotifications.size} remain)`);
    // If no old entries to remove but still > 50, force-clean oldest entries
    if (removed === 0 && recentNotifications.size > 50) {
      const entries = [...recentNotifications.entries()].sort((a, b) => a[1] - b[1]);
      const toDelete = entries.slice(0, recentNotifications.size - 50);
      for (const [t] of toDelete) recentNotifications.delete(t);
      log(`[BROADCAST] force-cleaned ${toDelete.length} oldest entries`);
    }
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
    // Flush each unique sid to trigger wechat-acp message delivery
    const flushedSids = [...grouped.keys()];
    log(`[DRAIN] flushing ${flushedSids.length} sid(s)`);
    for (const sid of flushedSids) {
      flushToWeChat(sid);
    }
    if (forceFlush) {
      log(`[DRAIN] force flush done`);
    }
  } catch (e) {
    log(`[DRAIN] error: ${e.message}`);
  } finally {
    draining = false;
    log(`[DRAIN] end`);
  }
}

function flushToWeChat(sid) {
  const flushSid = sid || lastPromptSid;
  if (!flushSid) { log(`[FLUSH] SKIP: no sid`); return; }
  sendNotification('session/update', {
    sessionId: flushSid,
    update: {
      sessionUpdate: 'tool_call',
      title: 'notification',
      toolCallId: uuid(),
      kind: 'other',
      status: 'completed',
    },
  });
}

// ───────── Realtime streaming helpers (FULL mode) ─────────

function flushRealtime(sid) {
  if (realtimeFlushTimer) {
    clearTimeout(realtimeFlushTimer);
    realtimeFlushTimer = null;
  }
  if (realtimeBuffer && sid && fullQuotaUsed < FULL_QUOTA_LIMIT) {
    const text = realtimeBuffer;
    realtimeBuffer = '';
    fullQuotaUsed++;
    reply(sid, text, uuid());
    flushToWeChat();
  }
}

function scheduleRealtimeFlush(sid) {
  if (realtimeFlushTimer) clearTimeout(realtimeFlushTimer);
  realtimeFlushTimer = setTimeout(() => flushRealtime(sid), REALTIME_FLUSH_MS);
  realtimeFlushTimer.unref?.();
}

function realtimeNotify(sid, text) {
  reply(sid, text, uuid());
}
function realtimeReply(sid, text) {
  reply(sid, text, currentTextMessageId);
}

function formatToolInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.slice(0, 60);
  if (typeof input === 'object') {
    const v = Object.values(input).find(v => typeof v === 'string');
    return v ? v.slice(0, 60) : Object.keys(input)[0] || '';
  }
  return '';
}

function formatDuration(startTime) {
  if (!startTime) return '';
  const dur = ((Date.now() - startTime) / 1000).toFixed(1);
  return `${dur}s`;
}

function clearToolStates() {
  toolStates.clear();
}

function updateSessionState(id, updates) {
  const existing = sessionStates.get(id) || {};
  const next = { ...existing, ...updates };
  sessionStates.set(id, next);
  return next;
}

function getSessionName(id) {
  const entry = sessionNames.get(id);
  if (entry && Date.now() - entry.ts < SESSION_NAME_TTL) return entry.name;
  return id?.slice(0, 12) || '?';
}

async function idleNotification(props, sendSid) {
  const sid = props.sessionID;
  if (!sid || idleNotified.has(sid)) return null;
  await fetchSessionName(sid);
  const name = getSessionName(sid);
  const text = `✅ ${name} · 完成`;
  const target = sendSid || lastPromptSid;
  if (!target) return null;
  idleNotified.add(sid);
  log(`[IDLE] immediate completion sid=${sid.slice(0,12)} via target=${target.slice(0,12)}: "${text}"`);
  reply(target, text);
  sendNotification('session/update', {
    sessionId: target,
    update: {
      sessionUpdate: 'tool_call',
      title: 'notification',
      toolCallId: uuid(),
      kind: 'other',
      status: 'completed',
    },
  });
  return null;
}

// Handle side-effects for SSE events (session tracking, etc.)
async function handleSseSideEffect(type, props) {
  switch (type) {
    case 'tui.session.select': {
      const sid = props.sessionID || props.id;
      if (!sid || sid === currentSessionId) return;
      log(`[SSE] tui.session.select: skip auto-follow from other clients`);
      return;
    }
    case 'session.created': {
      const sid = props.sessionID || props.id;
      if (!sid) return;
      log(`[SSE] session.created: ${sid.slice(0,12)}`);
      const dir = props.directory;
      if (dir && normalizeDir(dir) === normalizeDir(getWorkspaceDir())) {
        log(`[SSE] new session in current workspace: ${sid.slice(0,12)}`);
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
      const autoClear = setTimeout(() => {
        if (pendingQuestions?.askTimestamp === ts) { clearCurrentQuestion(); dequeueNextQuestion(); }
      }, QUESTION_AUTO_CLEAR_MS);
      autoClear.unref?.();
      qData._autoClearTimer = autoClear;
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
        // Dedup: suppress if same session has another pending with identical path (or both lack path)
        let dup = false;
        for (const [existingRid, info] of pendingPermissions) {
          if (info.sessionID !== sesId) continue;
          if (!p && !info.patterns) { dup = true; break; }
          if (p && info.patterns === p) { dup = true; break; }
        }
        if (dup) {
          log(`[EVENT] permission.asked: duplicate (same session+path), suppressing`);
          return null;
        }
        log(`[EVENT] permission.asked: storing rid in pendingPermissions`);
        pendingPermissions.set(rid, { sessionID: sesId, permission: t, patterns: p, ts: Date.now() });
        setTimeout(() => {
          log(`[TIMER] auto-clean rid=${rid.slice(0,16)}...`);
          pendingPermissions.delete(rid);
        },     QUESTION_AUTO_CLEAR_MS).unref?.();
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
          clearCurrentQuestion();
          await dequeueNextQuestion();
        }
        const before = pendingQuestionQueue.length;
        for (const q of pendingQuestionQueue) {
          if (q.requestID === qrid) clearQuestionTimer(q);
        }
        pendingQuestionQueue = pendingQuestionQueue.filter(q => q.requestID !== qrid);
        if (pendingQuestionQueue.length !== before) {
          log(`[EVENT] removed ${before - pendingQuestionQueue.length} from queue`);
        }
      }
      return null;
    }
    case 'session.idle': {
      // Clear stale pending questions only if no active interaction
      if (lastPromptSessionId !== props.sessionID) {
        if (pendingQuestions && pendingQuestions.sessionID === props.sessionID) {
          clearCurrentQuestion();
        }
        for (const q of pendingQuestionQueue) {
          if (q.sessionID === props.sessionID) clearQuestionTimer(q);
        }
        pendingQuestionQueue = pendingQuestionQueue.filter(q => q.sessionID !== props.sessionID);
      }
      clearToolStates();

      if (props.sessionID && props.sessionID === lastPromptSessionId) {
        if (idleHandled) return null;
        idleHandled = true;
        if (isFull()) {
          // FULL mode: flush remaining buffer with persistent messageId
          const hadOverflow = pendingTruncated;
          if (realtimeBuffer && lastPromptSid) {
            let text = realtimeBuffer;
            if (text.length > MAX_REALTIME_BUFFER) {
              if (quotaMode === 'continue') {
                if (text.slice(MAX_REALTIME_BUFFER).length >= MIN_CONTINUATION_LENGTH) {
                  pendingContinuation = splitContinuationMessages(text.slice(MAX_REALTIME_BUFFER), lastPromptSid);
                  text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（剩余内容请发 /g 继续获取）';
                } else {
                  text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（回复已截断，超出上限）';
                }
              } else if (quotaMode === 'notify') {
                text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（回复已截断，超出上限）';
              } else {
                text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（内容过长，请在 OpenCode 界面查看完整输出）';
              }
            }
            reply(lastPromptSid, text, currentTextMessageId);
            realtimeBuffer = '';
          }
          pendingReplyText = '';
          pendingTruncated = false;
          if (!responseSent) {
            responseSent = true;
            responseForSession = props.sessionID;
            disarmWorkingNotice();
            log(`[IDLE] FULL mode: flushed and marked sent`);
            flushToWeChat();
          }
          if (hadOverflow && quotaMode !== 'continue') {
            reply(lastPromptSid, '⚠️ 回复过长已截断，完整内容请在 OpenCode 界面查看');
            flushToWeChat();
          }
          if (pendingContinuation && !continuationNotified) {
            continuationNotified = true;
            reply(pendingContinuation.sid, `📬 回复过长已保存，发 /g 继续接收（共 ${pendingContinuation.total} 条）`);
            flushToWeChat();
          }
          return await idleNotification(props, lastPromptSid);
        }
        // PAD/PHONE mode: send accumulated text as one message
        let text = pendingReplyText.trim();
        pendingReplyText = '';
        if (text) {
          if (responseSent) return null; // forwardToAIAsync already sent
          if (quotaMode === 'continue' && text.length > MAX_REALTIME_BUFFER) {
            if (text.slice(MAX_REALTIME_BUFFER).length >= MIN_CONTINUATION_LENGTH) {
              pendingContinuation = splitContinuationMessages(text.slice(MAX_REALTIME_BUFFER), lastPromptSid);
              text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（剩余内容请发 /g 继续获取）';
            } else {
              text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（回复已截断，超出上限）';
            }
          } else if (quotaMode === 'notify' && text.length > MAX_REALTIME_BUFFER) {
            text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（回复已截断，超出上限）';
          } else if (text.length > MAX_REALTIME_BUFFER) {
            text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（内容过长，请在 OpenCode 界面查看完整输出）';
          }
          responseSent = true;
          responseForSession = props.sessionID;
          disarmWorkingNotice();
          log(`[IDLE] replying with text len=${text.length}`);
          reply(lastPromptSid, `🤖 ${text}`);
          flushToWeChat();
          if (pendingContinuation && !continuationNotified) {
            continuationNotified = true;
            reply(pendingContinuation.sid, `📬 回复过长已保存，发 /g 继续接收（共 ${pendingContinuation.total} 条）`);
            flushToWeChat();
          }
          return await idleNotification(props, lastPromptSid);
        }
        if (!responseSent) {
          log(`[IDLE] no text accumulated, deferring to forwardToAIAsync`);
          return null;
        }
        return null;
      }
      // Not the current active session — don't notify
      return null;
    }
    case 'session.status': {
      const st = props.status;
      if (!st) return null;
      if (st.type === 'idle') {
        clearToolStates();
        updateSessionState(props.sessionID, { retryCount: 0, busySince: undefined });
        if (props.sessionID && props.sessionID === lastPromptSessionId) {
          if (idleHandled) return null;
          idleHandled = true;
          if (isFull()) {
            // FULL mode: flush buffer with persistent messageId
            const hadOverflow = pendingTruncated;
            if (realtimeBuffer && lastPromptSid) {
              let text = realtimeBuffer;
              if (text.length > MAX_REALTIME_BUFFER) {
                if (quotaMode === 'continue') {
                  if (text.slice(MAX_REALTIME_BUFFER).length >= MIN_CONTINUATION_LENGTH) {
                    pendingContinuation = splitContinuationMessages(text.slice(MAX_REALTIME_BUFFER), lastPromptSid);
                    text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（剩余内容请发 /g 继续获取）';
                  } else {
                    text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（回复已截断，超出上限）';
                  }
                } else if (quotaMode === 'notify') {
                  text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（回复已截断，超出上限）';
                } else {
                  text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（内容过长，请在 OpenCode 界面查看完整输出）';
                }
              }
              reply(lastPromptSid, text, currentTextMessageId);
              realtimeBuffer = '';
            }
            pendingReplyText = '';
            pendingTruncated = false;
            if (!responseSent) {
              responseSent = true;
              responseForSession = props.sessionID;
              disarmWorkingNotice();
              flushToWeChat();
            }
            if (hadOverflow && quotaMode !== 'continue') {
              reply(lastPromptSid, '⚠️ 回复过长已截断，完整内容请在 OpenCode 界面查看');
              flushToWeChat();
            }
            if (!continuationNotified && pendingContinuation) {
              continuationNotified = true;
              reply(pendingContinuation.sid, `📬 回复过长已保存，发 /g 继续接收（共 ${pendingContinuation.total} 条）`);
              flushToWeChat();
            }
            return await idleNotification(props, lastPromptSid);
          }
          // PAD/PHONE mode: send accumulated text as one message
          let text = pendingReplyText.trim();
          pendingReplyText = '';
          if (text) {
            if (responseSent) return null;
            if (quotaMode === 'continue' && text.length > MAX_REALTIME_BUFFER) {
              if (text.slice(MAX_REALTIME_BUFFER).length >= MIN_CONTINUATION_LENGTH) {
                pendingContinuation = splitContinuationMessages(text.slice(MAX_REALTIME_BUFFER), lastPromptSid);
                text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（剩余内容请发 /g 继续获取）';
              } else {
                text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（回复已截断，超出上限）';
              }
            } else if (quotaMode === 'notify' && text.length > MAX_REALTIME_BUFFER) {
              text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（回复已截断，超出上限）';
            } else if (text.length > MAX_REALTIME_BUFFER) {
              text = text.slice(0, MAX_REALTIME_BUFFER) + '\n\n…（内容过长，请在 OpenCode 界面查看完整输出）';
            }
            responseSent = true;
            responseForSession = props.sessionID;
            disarmWorkingNotice();
            log(`[STATUS.IDLE] replying with text len=${text.length}`);
            reply(lastPromptSid, `🤖 ${text}`);
            flushToWeChat();
            if (!continuationNotified && pendingContinuation) {
              continuationNotified = true;
              reply(pendingContinuation.sid, `📬 回复过长已保存，发 /g 继续接收（共 ${pendingContinuation.total} 条）`);
              flushToWeChat();
            }
            return await idleNotification(props, lastPromptSid);
          }
          if (!responseSent) {
            return null;
          }
          // Already sent by forwardToAIAsync, just suppress "完成"
          return null;
        }
        return null;
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
      if (!psid || psid !== lastPromptSessionId) return null;

      const part = props.part || {};
      const partType = props.field || props.partType || part.type || '';
      const isDeltaEvent = type === 'message.part.delta';
      // delta events carry incremental content; updated events carry full snapshots (only use explicit delta)
      const delta = isDeltaEvent ? (props.delta || part.text || '') : (props.delta || '');
      const toolName = part.tool || '';
      const toolStatus = part.state?.status || '';
      const toolOutput = part.state?.output || '';
      const partId = part.id || '';
      const reasonTime = part.time || {};

      log(`[SSE] delta: type=${type} field="${partType}" tool="${toolName}" delta_len=${delta.length} psid=${(psid||'?').slice(0,12)}`);

      if (isFull()) {
        // ── FULL: real-time streaming with persistent messageId ──
        // All text chunks use currentTextMessageId; wechat-acp buffers chunks by session
        // reasoning/tool notifications get separate messageIds (new uuid) → separate messages
        if (partType === 'text' && delta) {
          if (fullQuotaUsed < FULL_QUOTA_LIMIT || realtimeBuffer.length < MAX_REALTIME_BUFFER) {
            realtimeBuffer += delta;
          } else if (!pendingTruncated) {
            pendingTruncated = true;
          }
          scheduleRealtimeFlush(lastPromptSid);
          if (pendingReplyText.length < MAX_ACCUMULATED_TEXT || quotaMode === 'continue') {
            pendingReplyText += delta;
          } else if (!pendingTruncated) {
            pendingTruncated = true;
            pendingReplyText += '\n\n…（内容过长，请在 OpenCode 界面查看完整输出）';
          }
          if (fullQuotaUsed < FULL_QUOTA_LIMIT && (realtimeBuffer.length >= REALTIME_MIN_FLUSH || (realtimeBuffer.length > 500 && /[\n。！？.!?]/.test(delta)))) {
            if (realtimeFlushTimer) {
              clearTimeout(realtimeFlushTimer);
              realtimeFlushTimer = null;
            }
            const text = realtimeBuffer;
            realtimeBuffer = '';
            if (text.trim() && lastPromptSid) {
              fullQuotaUsed++;
              reply(lastPromptSid, text, uuid());
              flushToWeChat();
            }
          }
          return null;
        }
        if (partType === 'reasoning') {
          if (reasonTime.start && !toolStates.has(partId + '_reason')) {
            toolStates.set(partId + '_reason', { startTime: Date.now() });
            if (lastPromptSid) realtimeNotify(lastPromptSid, '🤔 Thinking...');
          }
          if (delta && lastPromptSid) {
            if (fullQuotaUsed < FULL_QUOTA_LIMIT || realtimeBuffer.length < MAX_REALTIME_BUFFER) {
              realtimeBuffer += delta;
            }
            if (pendingReplyText.length < MAX_ACCUMULATED_TEXT || quotaMode === 'continue') {
              pendingReplyText += delta;
            }
          }
          if (reasonTime.end) {
            const ts = toolStates.get(partId + '_reason');
            const dur = ts ? formatDuration(ts.startTime) : '';
            if (lastPromptSid) realtimeNotify(lastPromptSid, `✅ Thinking complete${dur ? ' (' + dur + ')' : ''}`);
            toolStates.delete(partId + '_reason');
          }
          return null;
        }
        if (toolName) {
          if (toolStatus === 'running' || (!toolStatus && !toolStates.has(partId))) {
            if (!toolStates.has(partId)) {
              toolStates.set(partId, { tool: toolName, input: part.input, startTime: Date.now() });
              const inp = formatToolInput(part.input);
              if (lastPromptSid) realtimeNotify(lastPromptSid, `🔧 ${toolName}${inp ? ' ' + inp : ''}`);
            }
          } else if (toolStatus === 'completed') {
            clearToolStates();
            const outBrief = toolOutput ? toolOutput.replace(/\n/g, ' ').slice(0, 120) : '';
            if (lastPromptSid) {
              if (outBrief) {
                realtimeNotify(lastPromptSid, `✅ ${toolName}\n${outBrief}`);
              } else {
                realtimeNotify(lastPromptSid, `✅ ${toolName}`);
              }
            }
          } else if (toolStatus === 'error') {
            clearToolStates();
            if (lastPromptSid) realtimeNotify(lastPromptSid, `❌ ${toolName}: ${toolOutput || 'error'}`);
          }
          return null;
        }
        if (delta && lastPromptSid) {
          if (fullQuotaUsed < FULL_QUOTA_LIMIT || realtimeBuffer.length < MAX_REALTIME_BUFFER) {
            realtimeBuffer += delta;
          }
          if (pendingReplyText.length < MAX_ACCUMULATED_TEXT || quotaMode === 'continue') {
            pendingReplyText += delta;
          }
        }
        return null;
      }

      if (isPhone()) {
        // ── PHONE: text only, one 🤔 on first activity ──
        if (partType === 'reasoning' && reasonTime.start && !processingNotified) {
          processingNotified = true;
          if (lastPromptSid) { reply(lastPromptSid, '🤔', currentTextMessageId); flushToWeChat(); }
          return null;
        }
        if (toolName && (toolStatus === 'running' || !toolStatus) && !toolStates.has(partId)) {
          toolStates.set(partId, { tool: toolName, input: part.input, startTime: Date.now() });
          if (!processingNotified) {
            processingNotified = true;
            if (lastPromptSid) { reply(lastPromptSid, '🤔', currentTextMessageId); flushToWeChat(); }
          }
          return null;
        }
        if (partType === 'text' && delta) {
          if (pendingReplyText.length < MAX_ACCUMULATED_TEXT || quotaMode === 'continue') {
            pendingReplyText += delta;
          } else if (!pendingTruncated) {
            pendingTruncated = true;
            pendingReplyText += '\n\n…（内容过长）';
          }
        }
        return null;
      }

      // ── PAD (default): batch text, suppress tool/reasoning broadcasts ──
      if (partType === 'text' && delta) {
        if (pendingReplyText.length < MAX_ACCUMULATED_TEXT || quotaMode === 'continue') {
          pendingReplyText += delta;
        } else if (!pendingTruncated) {
          pendingTruncated = true;
          pendingReplyText += '\n\n…（内容过长）';
        }
        return null;
      }

      if (partType === 'reasoning') {
        if (reasonTime.start && !processingNotified) {
          processingNotified = true;
          if (lastPromptSid) { reply(lastPromptSid, '🤔 AI正在处理...', currentTextMessageId); flushToWeChat(); }
        }
        return null;
      }

      if (toolName) {
        if ((toolStatus === 'running' || !toolStatus) && !toolStates.has(partId)) {
          toolStates.set(partId, { tool: toolName, input: part.input, startTime: Date.now() });
          if (!processingNotified) {
            processingNotified = true;
            if (lastPromptSid) { reply(lastPromptSid, '🤔 AI正在处理...', currentTextMessageId); flushToWeChat(); }
          }
        }
        if (toolStatus === 'completed') {
          clearToolStates();
        }
        if (toolStatus === 'error') {
          clearToolStates();
        }
        return null;
      }

      return null;
    }
    default:
      return null;
  }
}

async function fetchSessionName(id) {
  if (!id) return;
  const entry = sessionNames.get(id);
  if (entry && Date.now() - entry.ts < SESSION_NAME_TTL) return;
  try {
    const { data } = await sdkClient.session.get({ sessionID: id });
    if (data?.title) sessionNames.set(id, { name: data.title, ts: Date.now() });
  } catch { log(`[FETCH] session name failed for ${id?.slice(0,12)}`); }
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
    if (sseRestarting) {
      log(`[SSE] Skip retry: sseRestarting is true (watchdog already handling)`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    try {
      sseRestarting = true;
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
      sseConnectionActive = true;
      const decoder = new TextDecoder();
      let buf = '';
      let currentEvent = '';
      let currentData = '';

      while (true) {
        // SSE 读取超时：5 分钟无数据则关闭重连（防止半开连接无限挂起）
        let sseTimedOut = false;
        sseReadTimer = setTimeout(() => {
          sseTimedOut = true;
          log(`[SSE] Read timeout (5min no data), aborting connection...`);
          sseConnectionActive = false;
          reader.cancel().catch(() => {});
        }, 300000);
        sseReadTimer.unref?.();

        let readResult;
        try {
          readResult = await reader.read();
        } finally {
          if (sseReadTimer) { clearTimeout(sseReadTimer); sseReadTimer = null; }
        }
        if (sseTimedOut) {
          log(`[SSE] timeout triggered before read completed, breaking`);
          sseConnectionActive = false;
          break;
        }
        const { done, value } = readResult;
        if (done) break;
        sseConnectionActive = true;

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

                // Event-level dedup: combine event type + id to avoid cross-event collisions
                const dedupKey = eventId ? `${eventType}:${eventId}` : null;
                if (dedupKey && recentEventIds.has(dedupKey)) {
                  log(`[SSE] EVENT DEDUP skip: ${eventType} id=${eventId.slice(0,24)}`);
                  currentEvent = '';
                  currentData = '';
                  continue;
                }
                if (dedupKey) {
                  recentEventIds.add(dedupKey);
                  setTimeout(() => recentEventIds.delete(dedupKey), 10000).unref?.();
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
      sseConnectionActive = false;
      sseRestarting = false;
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
  let lastPermSyncCheck = 0;
  const PERM_SYNC_INTERVAL = 5 * 60 * 1000;
  let lastSseHealthWarn = 0;

  setInterval(() => {
    try {
      const now = Date.now();

      // SSE 连接健康检查 + 自动重连
      if (!sseConnectionActive && sseReader === null) {
        if (now - lastSseHealthWarn > 60000) {
          lastSseHealthWarn = now;
          if (!sseRestarting) {
            sseRestarting = true;
            log(`[WATCHDOG] SSE is down, attempting restart...`);
            connectSSE().catch(e => log(`[WATCHDOG] SSE restart failed: ${e.message}`)).finally(() => { sseRestarting = false; });
          }
        }
      } else if (sseConnectionActive) {
        lastSseHealthWarn = 0;
      }

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
      // 清理孤儿 sessionNames（有 entry 但对应的 session 已不存在）
      const activeSessionIds = new Set([...sessionStates.keys(), currentSessionId].filter(Boolean));
      for (const [id] of sessionNames) {
        if (!activeSessionIds.has(id) && (Date.now() - (sessionNames.get(id)?.ts || 0) > 3600000)) {
          sessionNames.delete(id);
        }
      }

      // Periodic permission sync (run every 5 min)
      if (now - lastPermSyncCheck > PERM_SYNC_INTERVAL) {
        lastPermSyncCheck = now;
        syncPermissionsFromServer().catch(e => log(`[SYNC] perm sync error: ${e.message}`));
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
        // Clean stdout drop warning log cache
        stdoutDropLogged.clear();
      }

      // Warn and truncate if pendingReplyText is very large (skip in continue mode — needs all text)
      if (quotaMode !== 'continue' && pendingReplyText.length > 30000) {
        log(`[WATCHDOG] WARN: pendingReplyText=${pendingReplyText.length} chars, truncating to 20000`);
        pendingReplyText = pendingReplyText.slice(0, 20000);
        pendingTruncated = true;
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
