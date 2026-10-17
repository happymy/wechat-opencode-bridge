import { describe, it, expect, beforeEach, vi } from 'vitest';

// `@opencode/client` is replaced with a controllable fake so the shim's
// v2→v1 translation can be driven deterministically.
const hoisted = vi.hoisted(() => ({ fake: null }));

vi.mock('@opencode/client', () => ({
  OpenCode: { make: () => hoisted.fake },
}));

// tests/setup.js mocks ../src/opencode-compat.js globally, so pull the real
// module in explicitly for these tests.
const { createOpencodeClient } = await vi.importActual('../src/opencode-compat.js');

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeChannel() {
  const queue = [];
  let pending = null;
  let closed = false;
  return {
    push(ev) {
      if (pending) { const r = pending; pending = null; r({ value: ev, done: false }); }
      else queue.push(ev);
    },
    iterator: {
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => { pending = res; });
      },
      return() { closed = true; return Promise.resolve({ value: undefined, done: true }); },
    },
  };
}

let channel;

function makeFake() {
  return {
    session: {
      list: vi.fn(async () => ({ data: [] })),
      get: vi.fn(async () => ({ id: 's1', location: { directory: '/w' } })),
      create: vi.fn(async () => ({ id: 's1', location: { directory: '/w' }, time: { created: 5 } })),
      active: vi.fn(async () => ({ s1: { type: 'running' } })),
      interrupt: vi.fn(async () => ({ interrupted: true })),
      switchAgent: vi.fn(async () => {}),
      switchModel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({ id: 'm1', sessionID: 's1', type: 'user' })),
      compact: vi.fn(async () => ({ id: 'c1' })),
      context: vi.fn(async () => [{ id: 'u1', type: 'user' }, { id: 'a1', type: 'assistant' }]),
      revert: { stage: vi.fn(async () => ({})), clear: vi.fn(async () => {}) },
      form: { reply: vi.fn(async () => {}), cancel: vi.fn(async () => {}) },
    },
    permission: {
      request: { list: vi.fn(async () => ({ location: {}, data: [] })) },
      reply: vi.fn(async () => {}),
    },
    form: { list: vi.fn(async () => ({ location: {}, data: [] })) },
    project: { list: vi.fn(async () => []) },
    provider: { list: vi.fn(async () => ({ location: {}, data: [] })) },
    model: { list: vi.fn(async () => ({ location: {}, data: [] })) },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => channel.iterator }) },
  };
}

function client() {
  return createOpencodeClient({ baseUrl: 'http://localhost:4096/api/', headers: { Authorization: 'Basic x' } });
}

/** Start draining the event stream into `out`. */
function consume(c) {
  const out = [];
  c.event.subscribe({ directory: '/w' }).then(({ stream }) => {
    (async () => { for await (const e of stream) out.push(e); })();
  });
  return out;
}

beforeEach(() => {
  channel = makeChannel();
  hoisted.fake = makeFake();
});

describe('opencode-compat client shape', () => {
  it('exposes the v1 namespaces and strips /api from baseUrl', () => {
    const c = client();
    expect(Object.keys(c).sort()).toEqual(['client', 'config', 'event', 'permission', 'project', 'question', 'session', 'v2']);
    expect(c.client.getConfig().baseUrl).toBe('http://localhost:4096');
  });

  it('rebuilds on setConfig so the directory header changes', () => {
    const c = client();
    c.client.setConfig({ headers: { 'x-opencode-directory': 'ENC' } });
    expect(c.client.getConfig().headers).toEqual({ 'x-opencode-directory': 'ENC' });
  });
});

describe('session namespace', () => {
  it('maps location.directory and time.updated', async () => {
    const c = client();
    hoisted.fake.session.list.mockResolvedValue({
      data: [{ id: 's1', location: { directory: '/w' }, time: { created: 5 } }],
    });
    const { data } = await c.session.list({ limit: 10 });
    expect(data[0].directory).toBe('/w');
    expect(data[0].time.updated).toBe(5);
  });

  it('rejects get on error so callers can .catch', async () => {
    const c = client();
    hoisted.fake.session.get.mockRejectedValue(new Error('nope'));
    await expect(c.session.get({ sessionID: 'x' })).rejects.toThrow('nope');
  });

  it('derives the busy map from active()', async () => {
    const c = client();
    expect((await c.session.status()).data).toEqual({ s1: { type: 'busy' } });
  });

  it('abort → interrupt, unrevert → revert.clear, compact via v2', async () => {
    const c = client();
    await c.session.abort({ sessionID: 's1' });
    await c.session.unrevert({ sessionID: 's1' });
    await c.v2.session.compact({ sessionID: 's1' });
    expect(hoisted.fake.session.interrupt).toHaveBeenCalledWith({ sessionID: 's1' });
    expect(hoisted.fake.session.revert.clear).toHaveBeenCalledWith({ sessionID: 's1' });
    expect(hoisted.fake.session.compact).toHaveBeenCalledWith({ sessionID: 's1' });
  });

  it('revert stages at the last user message', async () => {
    const c = client();
    await c.session.revert({ sessionID: 's1' });
    expect(hoisted.fake.session.revert.stage).toHaveBeenCalledWith({ sessionID: 's1', messageID: 'u1' });
  });

  it('prompt blocks until the turn ends and returns accumulated text', async () => {
    const c = client();
    const out = consume(c);

    const p = c.session.prompt({ sessionID: 's1', parts: [{ type: 'text', text: 'hi' }] });
    await tick();

    channel.push({ type: 'session.text.delta', id: 'd1', data: { sessionID: 's1', delta: 'Hello' } });
    channel.push({ type: 'session.text.delta', id: 'd2', data: { sessionID: 's1', delta: ' world' } });
    await tick();

    let settled = false;
    p.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);

    channel.push({ type: 'session.execution.succeeded', id: 'e1', data: { sessionID: 's1' } });
    await tick();

    const res = await p;
    expect(res.data.parts[0].text).toBe('Hello world');
    expect(out.map((e) => e.type)).toEqual(['message.part.delta', 'message.part.delta', 'session.idle']);
  });

  it('passes agent/model through switchAgent/switchModel', async () => {
    const c = client();
    consume(c);
    const p = c.session.prompt({
      sessionID: 's1',
      parts: [{ type: 'text', text: 'hi' }],
      agent: 'plan',
      model: { providerID: 'anthropic', modelID: 'claude' },
    });
    await tick();
    channel.push({ type: 'session.idle', id: 'i1', data: { sessionID: 's1' } });
    await p;
    expect(hoisted.fake.session.switchAgent).toHaveBeenCalledWith({ sessionID: 's1', agent: 'plan' });
    expect(hoisted.fake.session.switchModel).toHaveBeenCalledWith({
      sessionID: 's1',
      model: { id: 'claude', providerID: 'anthropic', variant: undefined },
    });
  });
});

describe('event translation', () => {
  it('turns execution.failed into session.error', async () => {
    const c = client();
    const out = consume(c);
    channel.push({ type: 'session.execution.failed', id: 'f1', data: { sessionID: 's1', error: { message: 'boom', type: 'x' } } });
    await tick();
    expect(out[0].type).toBe('session.error');
    expect(out[0].properties.error.name).toBe('x');
    expect(out[0].properties.error.data.message).toBe('boom');
    expect(out[0].properties.error.message).toBe('boom');
  });

  it('keeps the tool name across input.started → success', async () => {
    const c = client();
    const out = consume(c);
    channel.push({ type: 'session.tool.input.started', id: 't1', data: { sessionID: 's1', id: 'call1', name: 'bash' } });
    channel.push({ type: 'session.tool.called', id: 't2', data: { sessionID: 's1', id: 'call1', input: { cmd: 'ls' } } });
    channel.push({ type: 'session.tool.success', id: 't3', data: { sessionID: 's1', id: 'call1', content: [{ type: 'text', text: 'done' }] } });
    await tick();
    const parts = out.map((e) => e.properties.part);
    expect(parts[0].tool).toBe('bash');
    expect(parts[1].tool).toBe('bash');
    expect(parts[2].tool).toBe('bash');
    expect(parts[1].input).toEqual({ cmd: 'ls' });
    expect(parts[2].state).toEqual({ status: 'completed', output: 'done' });
  });

  it('maps form.created to question.asked and replies with option values', async () => {
    const c = client();
    const out = consume(c);
    channel.push({
      type: 'form.created',
      id: 'q1',
      data: {
        form: {
          id: 'form1',
          sessionID: 's1',
          title: 'Pick',
          fields: [{ key: 'mode', type: 'string', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] }],
        },
      },
    });
    await tick();

    const ev = out.find((e) => e.type === 'question.asked');
    expect(ev.properties.requestID).toBe('form1');
    expect(ev.properties.questions[0].options[0].label).toBe('Alpha');
    expect(ev.properties.questions[0].multiple).toBe(false);

    await c.question.reply({ requestID: 'form1', answers: [['Beta']] });
    expect(hoisted.fake.session.form.reply).toHaveBeenCalledWith({
      sessionID: 's1',
      formID: 'form1',
      answer: { mode: 'b' },
    });
  });

  it('maps permission.asked and replies with the session from the event', async () => {
    const c = client();
    const out = consume(c);
    channel.push({
      type: 'permission.asked',
      id: 'p1',
      data: { id: 'req1', sessionID: 's1', action: 'bash', resources: ['rm -rf /'] },
    });
    await tick();

    const ev = out.find((e) => e.type === 'permission.asked');
    expect(ev.properties.requestID).toBe('req1');
    expect(ev.properties.permission).toBe('bash');
    expect(ev.properties.patterns).toEqual(['rm -rf /']);

    await c.permission.reply({ requestID: 'req1', reply: 'once', message: 'ok' });
    expect(hoisted.fake.permission.reply).toHaveBeenCalledWith({
      sessionID: 's1',
      requestID: 'req1',
      decision: 'once',
      message: 'ok',
    });
  });
});

describe('config.providers', () => {
  it('joins models onto their provider', async () => {
    const c = client();
    hoisted.fake.provider.list.mockResolvedValue({
      location: {},
      data: [{ id: 'anthropic', name: 'Anthropic' }],
    });
    hoisted.fake.model.list.mockResolvedValue({
      location: {},
      data: [{ id: 'claude', modelID: 'claude-3', providerID: 'anthropic', name: 'Claude 3' }],
    });
    const { data } = await c.config.providers();
    expect(Object.keys(data.providers[0].models)).toEqual(['claude-3']);
  });
});
