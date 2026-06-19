import { describe, it, expect } from 'vitest';
import { formatQuestionBody } from '../../../src/utils.js';

describe('formatQuestionBody', () => {
  it('空数组返回空', () => { expect(formatQuestionBody([])).toBe(''); });
  it('null 返回空', () => { expect(formatQuestionBody(null)).toBe(''); });
  it('undefined 返回空', () => { expect(formatQuestionBody(undefined)).toBe(''); });
  it('单问题无选项', () => {
    const r = formatQuestionBody([{ question: '继续吗？' }]);
    expect(r).toContain('继续吗？');
    expect(r).toContain('/ans');
    expect(r).not.toContain('编号选择');
  });
  it('单问题含选项', () => {
    const qs = [{ question: '选择颜色', options: [{ label: '红' }, { label: '蓝' }] }];
    const r = formatQuestionBody(qs);
    expect(r).toContain('选择颜色');
    expect(r).toContain('1. 红');
    expect(r).toContain('2. 蓝');
    expect(r).toContain('发送编号选择');
  });
  it('多问题', () => {
    const qs = [{ question: 'Q1' }, { question: 'Q2' }];
    const r = formatQuestionBody(qs);
    expect(r).toContain('1. Q1');
    expect(r).toContain('2. Q2');
    expect(r).toContain('逗号分隔');
  });
  it('多问题含选项', () => {
    const qs = [
      { question: '选语言', options: [{ label: 'JS' }, { label: 'TS' }] },
      { question: '选框架' },
    ];
    const r = formatQuestionBody(qs);
    expect(r).toContain('1. 选语言');
    expect(r).toContain('   1. JS');
    expect(r).toContain('2. 选框架');
  });
  it('secret 模式', () => {
    const qs = [{ question: '输入密码', isSecret: true }];
    const r = formatQuestionBody(qs);
    expect(r).toContain('保密发送');
  });
  it('单问题空文本', () => {
    const r = formatQuestionBody([{ question: '' }]);
    expect(r).toContain('/ans');
  });
  it('多问题含空文本', () => {
    const r = formatQuestionBody([{ question: '' }, { question: 'Q2' }]);
    expect(r).toContain('1. ');
    expect(r).toContain('2. Q2');
    expect(r).toContain('逗号分隔');
  });
  it('选项超过 6 个只显示前 6', () => {
    const opts = Array.from({ length: 8 }, (_, i) => ({ label: `选项${i + 1}` }));
    const qs = [{ question: '选一个', options: opts }];
    const r = formatQuestionBody(qs);
    expect(r).toContain('1. 选项1');
    expect(r).toContain('6. 选项6');
    expect(r).not.toContain('7. 选项7');
  });
});
