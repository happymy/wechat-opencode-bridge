import { describe, it, expect } from 'vitest';
import {
  levelIcon, levelDesc, levelLabel, quotaModeLabel,
  summarizeText, formatDuration, normalizeDir, wsPathEqual,
  makeWsName, formatReply, formatToolInput,
  resolveFilterLevel, resolveQuotaMode,
  getAllQuestions, parseWorkspaceArg, parseSessionIndex,
  splitContinuationMessages, QUOTA_LABELS,
} from '../../../src/utils.js';

describe('levelIcon', () => {
  it('FULL -> 📡', () => { expect(levelIcon('full')).toBe('📡'); });
  it('PAD -> 📱', () => { expect(levelIcon('pad')).toBe('📱'); });
  it('PHONE -> 📟', () => { expect(levelIcon('phone')).toBe('📟'); });
  it('unknown -> 🔍', () => { expect(levelIcon('xyz')).toBe('🔍'); });
});

describe('levelDesc', () => {
  it('FULL 描述', () => { expect(levelDesc('full')).toContain('实时流式输出'); });
  it('PAD 描述', () => { expect(levelDesc('pad')).toContain('等待提示'); });
  it('PHONE 描述', () => { expect(levelDesc('phone')).toContain('极简模式'); });
  it('unknown -> 空串', () => { expect(levelDesc('xyz')).toBe(''); });
});

describe('levelLabel', () => {
  it('FULL 标签', () => { expect(levelLabel('full')).toBe('📡 FULL 完整模式'); });
  it('PAD 标签', () => { expect(levelLabel('pad')).toBe('📱 PAD 标准模式'); });
  it('PHONE 标签', () => { expect(levelLabel('phone')).toBe('📟 PHONE 极简模式'); });
  it('unknown -> 原值', () => { expect(levelLabel('xyz')).toBe('xyz'); });
});

describe('quotaModeLabel', () => {
  it('truncate', () => { expect(quotaModeLabel('truncate')).toBe(QUOTA_LABELS.truncate); });
  it('notify', () => { expect(quotaModeLabel('notify')).toBe(QUOTA_LABELS.notify); });
  it('continue', () => { expect(quotaModeLabel('continue')).toBe(QUOTA_LABELS.continue); });
  it('unknown -> 原值', () => { expect(quotaModeLabel('xyz')).toBe('xyz'); });
});

describe('summarizeText', () => {
  it('不截断', () => { expect(summarizeText('hello', 10)).toBe('hello'); });
  it('截断并显示总数', () => {
    const r = summarizeText('hello world', 5);
    expect(r).toContain('hello');
    expect(r).toContain('共11字符');
  });
  it('空文本返回原值', () => { expect(summarizeText('', 10)).toBe(''); });
  it('null 返回 null', () => { expect(summarizeText(null, 10)).toBeNull(); });
  it('undefined 返回 undefined', () => { expect(summarizeText(undefined, 10)).toBeUndefined(); });
  it('刚好等于 maxLen 不截断', () => { expect(summarizeText('12345', 5)).toBe('12345'); });
});

describe('resolveFilterLevel', () => {
  it('别名 f → full', () => { expect(resolveFilterLevel('f')).toBe('full'); });
  it('别名 p → pad', () => { expect(resolveFilterLevel('p')).toBe('pad'); });
  it('别名 pd → pad', () => { expect(resolveFilterLevel('pd')).toBe('pad'); });
  it('别名 ph → phone', () => { expect(resolveFilterLevel('ph')).toBe('phone'); });
  it('全名 full', () => { expect(resolveFilterLevel('full')).toBe('full'); });
  it('全名 phone', () => { expect(resolveFilterLevel('phone')).toBe('phone'); });
  it('大写别名', () => { expect(resolveFilterLevel('F')).toBe('full'); });
  it('无效值返回 null', () => { expect(resolveFilterLevel('xxx')).toBeNull(); });
  it('空字符串返回 null', () => { expect(resolveFilterLevel('')).toBeNull(); });
  it('null 返回 null', () => { expect(resolveFilterLevel(null)).toBeNull(); });
  it('undefined 返回 null', () => { expect(resolveFilterLevel(undefined)).toBeNull(); });
});

describe('resolveQuotaMode', () => {
  it('别名 t → truncate', () => { expect(resolveQuotaMode('t')).toBe('truncate'); });
  it('别名 trunc → truncate', () => { expect(resolveQuotaMode('trunc')).toBe('truncate'); });
  it('别名 n → notify', () => { expect(resolveQuotaMode('n')).toBe('notify'); });
  it('别名 notif → notify', () => { expect(resolveQuotaMode('notif')).toBe('notify'); });
  it('别名 c → continue', () => { expect(resolveQuotaMode('c')).toBe('continue'); });
  it('别名 cont → continue', () => { expect(resolveQuotaMode('cont')).toBe('continue'); });
  it('全名 truncate', () => { expect(resolveQuotaMode('truncate')).toBe('truncate'); });
  it('大写别名', () => { expect(resolveQuotaMode('T')).toBe('truncate'); });
  it('带空格', () => { expect(resolveQuotaMode('  t  ')).toBe('truncate'); });
  it('无效值返回 null', () => { expect(resolveQuotaMode('xxx')).toBeNull(); });
  it('空字符串返回 null', () => { expect(resolveQuotaMode('')).toBeNull(); });
  it('null 返回 null', () => { expect(resolveQuotaMode(null)).toBeNull(); });
  it('undefined 返回 null', () => { expect(resolveQuotaMode(undefined)).toBeNull(); });
});

describe('getAllQuestions', () => {
  it('无待回答问题', () => { expect(getAllQuestions(null, [])).toEqual([]); });
  it('有当前问题', () => {
    const active = { requestID: 'r1', questions: [{ question: 'test' }] };
    expect(getAllQuestions(active, [])).toEqual([active]);
  });
  it('有排队问题', () => {
    const queued = [{ requestID: 'r2' }, { requestID: 'r3' }];
    expect(getAllQuestions(null, queued)).toEqual(queued);
  });
  it('合并当前和排队', () => {
    const active = { requestID: 'r1' };
    const queued = [{ requestID: 'r2' }];
    const result = getAllQuestions(active, queued);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(active);
    expect(result[1]).toBe(queued[0]);
  });
  it('pendingQuestions 为 undefined', () => { expect(getAllQuestions(undefined, [])).toEqual([]); });
  it('queue 为 undefined', () => { expect(getAllQuestions(null, undefined)).toEqual([]); });
});

describe('parseWorkspaceArg', () => {
  it('add 带名称', () => {
    expect(parseWorkspaceArg('add /a/b myws')).toEqual({ action: 'add', dirPath: '/a/b', name: 'myws' });
  });
  it('add 不带名称', () => {
    const r = parseWorkspaceArg('add /a/b');
    expect(r.action).toBe('add');
    expect(r.dirPath).toBe('/a/b');
    expect(r.name).toBe('');
  });
  it('add 含多余空格', () => {
    expect(parseWorkspaceArg('add   /a/b   myws')).toEqual({ action: 'add', dirPath: '/a/b', name: 'myws' });
  });
  it('del 编号', () => { expect(parseWorkspaceArg('del 3')).toEqual({ action: 'del', index: 2 }); });
  it('delete 全拼', () => { expect(parseWorkspaceArg('delete 5')).toEqual({ action: 'del', index: 4 }); });
  it('switch 编号', () => { expect(parseWorkspaceArg('2')).toEqual({ action: 'switch', index: 1 }); });
  it('null 参数', () => { expect(parseWorkspaceArg(null)).toBeNull(); });
  it('空参数', () => { expect(parseWorkspaceArg('')).toBeNull(); });
  it('无效参数', () => { expect(parseWorkspaceArg('xxx')).toBeNull(); });
});

describe('parseSessionIndex', () => {
  it('正常编号', () => { expect(parseSessionIndex('3', 10)).toBe(2); });
  it('带空格 trim', () => { expect(parseSessionIndex('  2  ', 10)).toBe(1); });
  it('越界返回 null', () => { expect(parseSessionIndex('11', 10)).toBeNull(); });
  it('小于1返回 null', () => { expect(parseSessionIndex('0', 10)).toBeNull(); });
  it('空字符串', () => { expect(parseSessionIndex('', 10)).toBeNull(); });
  it('非数字', () => { expect(parseSessionIndex('abc', 10)).toBeNull(); });
  it('null', () => { expect(parseSessionIndex(null, 10)).toBeNull(); });
});

describe('formatDuration', () => {
  it('返回秒数', () => {
    const r = formatDuration(Date.now() - 5000);
    expect(r).toMatch(/^\d+\.\ds$/);
  });
  it('无 startTime 返回空', () => { expect(formatDuration(null)).toBe(''); });
  it('undefined 返回空', () => { expect(formatDuration(undefined)).toBe(''); });
});

describe('normalizeDir', () => {
  it('统一正斜杠', () => { expect(normalizeDir('a\\b\\c')).toBe('a/b/c'); });
  it('移除尾部斜杠', () => { expect(normalizeDir('a/b/c/')).toBe('a/b/c'); });
  it('转小写', () => { expect(normalizeDir('A/B/C')).toBe('a/b/c'); });
  it('空串保底', () => { expect(normalizeDir('')).toBe(''); });
});

describe('wsPathEqual', () => {
  it('完全一致', () => { expect(wsPathEqual('/a/b', '/a/b')).toBe(true); });
  it('尾部斜杠差异', () => { expect(wsPathEqual('/a/b/', '/a/b')).toBe(true); });
  it('大小写差异', () => { expect(wsPathEqual('/A/B', '/a/b')).toBe(true); });
  it('不同路径', () => { expect(wsPathEqual('/a/b', '/a/c')).toBe(false); });
});

describe('makeWsName', () => {
  it('基本名称', () => { expect(makeWsName('C:/projects/myapp', [])).toBe('myapp'); });
  it('名称冲突时用父目录前缀', () => {
    const existing = [{ name: 'myapp' }];
    const r = makeWsName('C:/projects/sub/myapp', existing);
    expect(r).toBe('sub/myapp');
  });
  it('单段路径冲突仍用原名', () => {
    const existing = [{ name: 'myapp' }];
    expect(makeWsName('myapp', existing)).toBe('myapp');
  });
});

describe('formatReply', () => {
  it('无 parts', () => { expect(formatReply({})).toBe('🤖 （无文本响应）'); });
  it('空 parts', () => { expect(formatReply({ parts: [] })).toBe('🤖 （无文本响应）'); });
  it('文本 parts', () => {
    expect(formatReply({ parts: [{ type: 'text', text: 'hello' }] })).toBe('🤖 hello');
  });
  it('多段合并', () => {
    const data = { parts: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
    expect(formatReply(data)).toBe('🤖 a\nb');
  });
  it('忽略非 text 类型', () => {
    const data = { parts: [{ type: 'tool_use', text: 'hidden' }, { type: 'text', text: 'visible' }] };
    expect(formatReply(data)).toBe('🤖 visible');
  });
  it('过滤空文本', () => {
    const data = { parts: [{ type: 'text', text: '' }, { type: 'text', text: 'ok' }] };
    expect(formatReply(data)).toBe('🤖 ok');
  });
  it('全空完成标记', () => {
    const data = { parts: [{ type: 'text', text: '  ' }] };
    expect(formatReply(data)).toBe('🤖 （完成）');
  });
});

describe('formatToolInput', () => {
  it('空', () => { expect(formatToolInput(null)).toBe(''); });
  it('字符串截断', () => { expect(formatToolInput('a'.repeat(100))).toHaveLength(60); });
  it('字符串不截断', () => { expect(formatToolInput('hello')).toBe('hello'); });
  it('对象找字符串值', () => { expect(formatToolInput({ file: 'test.js', mode: 'w' })).toBe('test.js'); });
  it('对象无字符串值返回键名', () => { expect(formatToolInput({ a: 1, b: 2 })).toBe('a'); });
  it('数字', () => { expect(formatToolInput(42)).toBe(''); });
});

describe('splitContinuationMessages', () => {
  it('短文本不分段', () => {
    const r = splitContinuationMessages('hello', 'sid1');
    expect(r.messages).toHaveLength(1);
    expect(r.total).toBe(1);
  });
  it('长文本分段', () => {
    const text = 'a'.repeat(5000);
    const r = splitContinuationMessages(text, 'sid1');
    expect(r.total).toBe(2);
    expect(r.messages[0]).toHaveLength(4000);
    expect(r.messages[1]).toHaveLength(1000);
  });
  it('空文本', () => {
    const r = splitContinuationMessages('', 'sid1');
    expect(r.messages).toHaveLength(0);
    expect(r.total).toBe(0);
  });
  it('正好 4000 字符', () => {
    const text = 'a'.repeat(4000);
    const r = splitContinuationMessages(text, 'sid1');
    expect(r.total).toBe(1);
    expect(r.messages[0]).toHaveLength(4000);
  });
  it('4001 字符分两段', () => {
    const text = 'a'.repeat(4001);
    const r = splitContinuationMessages(text, 'sid1');
    expect(r.total).toBe(2);
    expect(r.messages[0]).toHaveLength(4000);
    expect(r.messages[1]).toHaveLength(1);
  });
  it('返回 sid', () => {
    const r = splitContinuationMessages('hi', 'abc123');
    expect(r.sid).toBe('abc123');
  });
});
