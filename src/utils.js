export const MAX_REPLY_LENGTH = 4000;

import { resolve } from 'node:path';

export const FILTER_LEVELS = ['full', 'pad', 'phone'];
export const QUOTA_MODES = ['truncate', 'notify', 'continue'];
export const QUOTA_ALIASES = { t: 'truncate', trunc: 'truncate', n: 'notify', notif: 'notify', c: 'continue', cont: 'continue' };
export const FILTER_ALIASES = { f: 'full', p: 'pad', pd: 'pad', ph: 'phone' };

export function resolveFilterLevel(arg) {
  if (!arg) return null;
  const resolved = FILTER_ALIASES[arg.toLowerCase()] || arg.toLowerCase();
  return FILTER_LEVELS.includes(resolved) ? resolved : null;
}

export function resolveQuotaMode(arg) {
  if (!arg) return null;
  const mode = arg.trim().toLowerCase();
  const resolved = QUOTA_ALIASES[mode] || mode;
  return QUOTA_MODES.includes(resolved) ? resolved : null;
}

export function levelIcon(lv) {
  return { full: '📡', pad: '📱', phone: '📟' }[lv] || '🔍';
}

export function levelDesc(lv) {
  return {
    full: '实时流式输出 ⚠️ 高频推送触发限流时后半段静默丢失，不推荐日常使用',
    pad: '处理中显示等待提示，仅发送 AI 文本回复',
    phone: '极简模式，仅显示 AI 文本回复和 🤔 处理提示',
  }[lv] || '';
}

export function levelLabel(lv) {
  return { full: '📡 FULL 完整模式', pad: '📱 PAD 标准模式', phone: '📟 PHONE 极简模式' }[lv] || lv;
}

export const QUOTA_LABELS = {
  truncate: '🔇 静默截断 — 超限部分直接丢弃，不通知用户',
  notify: '🔔 截断通知 — 超限时通知用户回复被截断',
  continue: '📬 继续模式 — 保存超限文本，发 /g 自动续发',
};

export function quotaModeLabel(m) { return QUOTA_LABELS[m] || m; }

export function summarizeText(text, maxLen) {
  if (text == null) return text;
  const len = maxLen < 0 ? 0 : maxLen;
  if (text.length <= len) return text;
  return text.slice(0, len) + `\n…（共${text.length}字符，截断显示）`;
}

function basename(p) {
  if (!p) return '';
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').split('/').pop() || p;
}

export function makeWsName(dirPath, existing) {
  let name = basename(dirPath);
  if (existing.some(w => w.name === name)) {
    const parts = dirPath.replace(/[\\/]+/g, '/').replace(/\/$/, '').split('/');
    name = parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : name;
  }
  return name;
}

export function splitContinuationMessages(text, sid) {
  if (text == null) return { sid: sid || '', messages: [], total: 0 };
  const messages = [];
  for (let i = 0; i < text.length; i += MAX_REPLY_LENGTH) {
    messages.push(text.slice(i, i + MAX_REPLY_LENGTH));
  }
  return { sid, messages, total: messages.length };
}

export function formatReply(data) {
  const parts = data?.parts || [];
  if (!parts.length) return '🤖 （无文本响应）';
  const texts = parts.filter(p => p.type === 'text' && p.text).map(p => p.text);
  const mainText = texts.join('\n').trim();
  return mainText ? `🤖 ${mainText}` : '🤖 （完成）';
}

export function formatToolInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.slice(0, 60);
  if (typeof input === 'object' && !Array.isArray(input)) {
    const v = Object.values(input).find(v => typeof v === 'string');
    return v ? v.slice(0, 60) : Object.keys(input)[0] || '';
  }
  return '';
}

export function formatDuration(startTime) {
  if (!startTime) return '';
  const dur = ((Date.now() - startTime) / 1000).toFixed(1);
  return `${dur}s`;
}

export function wsPathEqual(a, b) {
  if (!a || !b) return a === b;
  try { return resolve(a).toLowerCase() === resolve(b).toLowerCase(); } catch { return a.toLowerCase() === b.toLowerCase(); }
}

export function normalizeDir(p) {
  if (!p) return '';
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

export function getAllQuestions(pendingQuestions, pendingQuestionQueue) {
  const all = [];
  if (pendingQuestions) all.push(pendingQuestions);
  if (pendingQuestionQueue?.length) {
    for (const q of pendingQuestionQueue) all.push(q);
  }
  return all;
}

export function parseWorkspaceArg(arg) {
  if (!arg) return null;
  const addMatch = arg.match(/^add\s+(.+?)(?:\s+(\S+))?$/i);
  if (addMatch) return { action: 'add', dirPath: addMatch[1].trim(), name: addMatch[2]?.trim() || '' };
  const delMatch = arg.match(/^del(?:ete)?\s+(\d+)$/i);
  if (delMatch) return { action: 'del', index: parseInt(delMatch[1], 10) - 1 };
  const num = parseInt(arg, 10);
  if (!isNaN(num) && num > 0) return { action: 'switch', index: num - 1 };
  return null;
}

export function parseSessionIndex(arg, max) {
  if (!arg?.trim()) return null;
  const num = parseInt(arg.trim(), 10);
  if (isNaN(num) || num < 1 || num > max) return null;
  return num - 1;
}

export function formatQuestionBody(questions) {
  if (!questions?.length) return '';
  const multi = questions.length > 1;
  let body = '';
  if (multi) {
    questions.forEach((qItem, idx) => {
      const qText = qItem.question || '';
      body += `\n\n${idx + 1}. ${qText}`;
      if (qItem.options?.length) {
        body += '\n' + qItem.options.slice(0, 6).map((o, j) => `   ${j + 1}. ${o.label}`).join('\n');
      }
    });
    body += '\n\n多个答案用逗号分隔，如：1, 2';
  } else {
    const qi = questions[0];
    const q = qi.question || '';
    const opts = qi.options?.slice(0, 6).map((o, i) => `${i + 1}. ${o.label}`).join('\n') || '';
    body += `\n${q}`;
    if (opts) body += `\n${opts}`;
    if (qi.isSecret) body += '\n🔒 答案将保密发送';
    body += '\n回复内容，或 /ans (/answer) <内容> 提交';
    if (opts) body += '，或发送编号选择';
  }
  body += '\n/skip (/pass, /ps) 跳过，/qlist (/ql, /questions) 查看全部，/qshow (/qc, /qcurrent) 查看详情，/qselect (/qs, /qsel) <编号> 切换';
  return body;
}
