import { describe, it, expect } from 'vitest';
import { formatReply } from '../../../src/utils.js';

describe('通知消息格式化', () => {
  it('完成通知', () => {
    const r = formatReply({ parts: [{ type: 'text', text: '任务执行完毕' }] });
    expect(r).toBe('🤖 任务执行完毕');
  });

  it('错误通知', () => {
    const r = formatReply({ parts: [{ type: 'text', text: '连接失败' }] });
    expect(r).toContain('连接失败');
  });

  it('空回复', () => {
    expect(formatReply({ parts: [] })).toBe('🤖 （无文本响应）');
  });

  it('仅 reasoning 的回复', () => {
    const r = formatReply({ parts: [{ type: 'reasoning', text: '思考过程' }] });
    expect(r).toBe('🤖 （完成）');
  });

  it('reasoning + text', () => {
    const r = formatReply({
      parts: [
        { type: 'reasoning', text: '思考' },
        { type: 'text', text: '最终答案' },
      ],
    });
    expect(r).toBe('🤖 最终答案');
  });

  it('tool_use 不干扰文本', () => {
    const r = formatReply({
      parts: [
        { type: 'text', text: '正在执行...' },
        { type: 'tool_use', name: 'write' },
        { type: 'text', text: '完成' },
      ],
    });
    expect(r).toBe('🤖 正在执行...\n完成');
  });
});
