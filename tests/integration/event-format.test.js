import { describe, it, expect } from 'vitest';
import { formatReply } from '../../src/utils.js';

describe('eventToNotification message formatting', () => {
  it('session.error 无错误对象', () => {
    expect(formatReply({ parts: [] })).toBe('🤖 （无文本响应）');
  });

  it('格式回复含工具调用', () => {
    const data = {
      parts: [
        { type: 'text', text: '分析完成' },
        { type: 'tool_use', text: '写入文件' },
      ],
    };
    expect(formatReply(data)).toContain('分析完成');
  });

  it('多个文本段合并', () => {
    const data = {
      parts: [
        { type: 'text', text: '第一步' },
        { type: 'text', text: '第二步' },
      ],
    };
    const r = formatReply(data);
    expect(r).toContain('第一步');
    expect(r).toContain('第二步');
  });

  it('只含 reasoning 块应返回完成标记', () => {
    const data = {
      parts: [
        { type: 'reasoning', text: '思考中...' },
        { type: 'text', text: '  ' },
      ],
    };
    expect(formatReply(data)).toBe('🤖 （完成）');
  });
});
