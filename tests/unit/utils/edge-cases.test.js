import { describe, it, expect } from 'vitest';
import {
  levelIcon, levelDesc, levelLabel, quotaModeLabel,
  summarizeText, formatDuration, normalizeDir, wsPathEqual,
  makeWsName, formatReply, formatToolInput,
  splitContinuationMessages, formatQuestionBody,
} from '../../../src/utils.js';

describe('levelIcon edge cases', () => {
  it('null / undefined / empty all fallback', () => {
    expect(levelIcon(null)).toBe('🔍');
    expect(levelIcon(undefined)).toBe('🔍');
    expect(levelIcon('')).toBe('🔍');
  });
  it('case sensitive - lowercase only', () => {
    expect(levelIcon('FULL')).toBe('🔍');
  });
});

describe('summarizeText edge cases', () => {
  it('maxLen=0 时截断', () => {
    const r = summarizeText('abc', 0);
    expect(r).toContain('共3字符');
  });
  it('maxLen 负数当做 0', () => {
    const r = summarizeText('abc', -1);
    expect(r).toContain('共3字符');
  });
  it('空字符串', () => { expect(summarizeText('', 10)).toBe(''); });
});

describe('formatDuration edge cases', () => {
  it('0 时长', () => {
    const r = formatDuration(Date.now());
    expect(r).toMatch(/^0\.0s$/);
  });
  it('负值（未来时间）', () => {
    const r = formatDuration(Date.now() + 10000);
    expect(parseFloat(r)).toBeLessThan(0);
  });
});

describe('normalizeDir edge cases', () => {
  it('混合分隔符', () => { expect(normalizeDir('a\\b/c\\d')).toBe('a/b/c/d'); });
  it('多斜杠合并', () => { expect(normalizeDir('a//b\\\\c')).toBe('a/b/c'); });
  it('仅尾部斜杠', () => { expect(normalizeDir('/')).toBe(''); });
  it('根路径', () => { expect(normalizeDir('C:\\')).toBe('c:'); });
  it('Unicode 路径', () => { expect(normalizeDir('项目/文件')).toBe('项目/文件'); });
});

describe('wsPathEqual edge cases', () => {
  it('backslash vs slash', () => { expect(wsPathEqual('C:\\a\\b', 'C:/a/b')).toBe(true); });
  it('null/undefined', () => {
    expect(wsPathEqual(null, null)).toBe(true);
    expect(wsPathEqual(undefined, undefined)).toBe(true);
    expect(wsPathEqual('/a', null)).toBe(false);
  });
});

describe('formatReply edge cases', () => {
  it('null data', () => { expect(formatReply(null)).toBe('🤖 （无文本响应）'); });
  it('undefined data', () => { expect(formatReply(undefined)).toBe('🤖 （无文本响应）'); });
  it('data without parts key', () => { expect(formatReply({ foo: 'bar' })).toBe('🤖 （无文本响应）'); });
  it('非对象 data', () => {
    expect(formatReply('hello')).toBe('🤖 （无文本响应）');
    expect(formatReply(42)).toBe('🤖 （无文本响应）');
  });
  it('只含 text 空格的 part', () => {
    expect(formatReply({ parts: [{ type: 'text', text: '   ' }] })).toBe('🤖 （完成）');
  });
  it('混合类型 parts', () => {
    const data = {
      parts: [
        { type: 'reasoning', text: 'thinking...' },
        { type: 'text', text: 'result' },
        { type: 'tool_use', name: 'write', input: {} },
      ],
    };
    expect(formatReply(data)).toBe('🤖 result');
  });
});

describe('formatToolInput edge cases', () => {
  it('空对象', () => { expect(formatToolInput({})).toBe(''); });
  it('对象含多个字符串值取第一个', () => {
    expect(formatToolInput({ a: 'first', b: 'second' })).toBe('first');
  });
  it('对象含数字值', () => { expect(formatToolInput({ a: 1 })).toBe('a'); });
  it('布尔值', () => { expect(formatToolInput(true)).toBe(''); });
  it('字符串短', () => { expect(formatToolInput('hi')).toBe('hi'); });
  it('64 字符串截断', () => { expect(formatToolInput('x'.repeat(70))).toHaveLength(60); });
});

describe('splitContinuationMessages edge cases', () => {
  it('null text', () => {
    const r = splitContinuationMessages(null, 's1');
    expect(r.total).toBe(0);
  });
  it('null text falsy sid', () => {
    const r = splitContinuationMessages(null, '');
    expect(r.sid).toBe('');
    expect(r.total).toBe(0);
  });
  it('undefined text', () => {
    const r = splitContinuationMessages(undefined, 's1');
    expect(r.total).toBe(0);
  });
  it('sid 为空', () => {
    const r = splitContinuationMessages('hi', '');
    expect(r.sid).toBe('');
    expect(r.total).toBe(1);
  });
});

describe('formatQuestionBody edge cases', () => {
  it('问题含空字符串', () => {
    const r = formatQuestionBody([{ question: '' }]);
    expect(r).toContain('/ans');
  });
  it('多问题含空选项数组', () => {
    const qs = [{ question: 'Q1', options: [] }, { question: 'Q2' }];
    const r = formatQuestionBody(qs);
    expect(r).toContain('1. Q1');
    expect(r).toContain('2. Q2');
  });
  it('多问题其中一项有选项', () => {
    const qs = [
      { question: '选一个', options: [{ label: '是' }, { label: '否' }] },
      { question: '为什么' },
    ];
    const r = formatQuestionBody(qs);
    expect(r).toContain('选一个');
    expect(r).toContain('   1. 是');
    expect(r).toContain('为什么');
  });
  it('单问题含 options 但 undefined', () => {
    const r = formatQuestionBody([{ question: '继续?', options: undefined }]);
    expect(r).toContain('继续?');
    expect(r).not.toContain('编号选择');
  });
});

describe('makeWsName edge cases', () => {
  it('空路径', () => { expect(makeWsName('', [])).toBe(''); });
  it('根路径', () => { expect(makeWsName('/', [])).toBe('/'); });
  it('空 existing', () => { expect(makeWsName('/a/b', [])).toBe('b'); });
  it('多级深度', () => { expect(makeWsName('/a/b/c/d', [])).toBe('d'); });
  it('尾部斜杠', () => { expect(makeWsName('/a/b/c/', [])).toBe('c'); });
  it('多个冲突', () => {
    const existing = [{ name: 'app' }];
    const r = makeWsName('/root/sub/app', existing);
    expect(r).toBe('sub/app');
  });
  it('Windows 路径', () => {
    expect(makeWsName('C:\\users\\me\\project', [])).toBe('project');
  });
  it('冲突时父目录不含斜杠', () => {
    const existing = [{ name: 'app' }];
    const r = makeWsName('/root/app', existing);
    expect(r).toBe('root/app');
  });
});
