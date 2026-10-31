/**
 * @opencode/client v2 → v1-preview compatibility shim.
 *
 * wechat-adapter.js was written against `@opencode-ai/sdk/v2/client` (the
 * `/api` preview of opencode 1.18/1.19). opencode 2.x keeps the `/api`
 * surface but renames routes and changes the wire protocol:
 *
 *   - questions      → forms (`permission.*` stays, `question.*` becomes `form.*`)
 *   - blocking prompt → inbox admission + streaming events
 *   - `{ data, error }` results → thrown ClientError
 *   - event envelope  → `{ type, data }` instead of `{ type, properties }`
 *   - directory scope → `x-opencode-directory` request header
 *
 * This shim re-exposes the old client shape on top of the v2 client so the
 * adapter body (39 call sites + ~500 lines of event handling) stays untouched.
 */
import { OpenCode } from '@opencode/client';

const DIRECTORY_HEADER = 'x-opencode-directory';

function errBody(e) {
  const message = e?.message || String(e || 'unknown error');
  return { message, data: { message } };
}

function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** v1 prompt took `parts`; v2 takes a single `text`. */
function partsToText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (typeof p === 'string' ? p : p?.text || ''))
    .filter(Boolean)
    .join('\n');
}

function toolOutputText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.text ?? c?.output ?? c?.content ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return error.message || error.type || '';
}

/**
 * v2 errors are `{ type, message, status? }`; the adapter renders
 * `err.name` + `err.data?.message || err.message`, so reshape to that.
 */
function toV1Error(error) {
  const message = errorText(error) || '未知错误';
  return { name: error?.type || 'Error', message, data: { message } };
}

/** v2 Form fields → the v1 `question` shape the adapter renders. */
function formToQuestions(form) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  return fields.map((field) => ({
    question: field.description || field.title || field.key || '',
    header: field.key || '',
    options: Array.isArray(field.options)
      ? field.options.map((o) => ({ label: o.label ?? o.value, description: o.description }))
      : [],
    multiple: field.type === 'multiselect',
  }));
}

/**
 * adapter answers (one entry per question) → v2 form answer keyed by field key.
 * The adapter resolves a numeric choice to an option's *label*, but v2 wants
 * the option's *value*, so map labels back through the field's options.
 */
function answersToFormAnswer(fields, answers) {
  const list = Array.isArray(fields) ? fields : [];
  const values = Array.isArray(answers) ? answers : [];
  const out = {};
  list.forEach((field, i) => {
    const raw = values[i] ?? values[0] ?? '';
    const opts = Array.isArray(field.options) ? field.options : [];
    const toValue = (v) => {
      const s = String(v).trim();
      const hit = opts.find((o) => String(o.label) === s || String(o.value) === s);
      return hit ? hit.value : v;
    };

    if (field.type === 'multiselect') {
      const parts = Array.isArray(raw) ? raw : String(raw).split(/[,，]/);
      out[field.key] = parts.map(toValue).filter((p) => p !== '');
    } else if (field.type === 'boolean') {
      out[field.key] = /^(true|yes|y|1|是|好|确认)$/i.test(String(raw).trim());
    } else if (field.type === 'number' || field.type === 'integer') {
      const n = Number(String(raw).trim());
      out[field.key] = Number.isNaN(n) ? raw : n;
    } else {
      out[field.key] = opts.length ? toValue(raw) : raw;
    }
  });
  return out;
}

function toModelRef(model) {
  return { id: model?.modelID || model?.id, providerID: model?.providerID, variant: model?.variant };
}

/** SessionInfo: expose `location.directory` as the v1 `directory` field. */
function mapSession(s) {
  if (!s) return s;
  const directory = s.location?.directory ?? s.directory;
  const time = s.time ? { ...s.time, updated: s.time.updated ?? s.time.created } : s.time;
  return { ...s, directory, time };
}

export function createOpencodeClient(options = {}) {
  const baseUrl = String(options.baseUrl || 'http://localhost:4096')
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');

  let headers = { ...(options.headers || {}) };
  if (options.directory) headers[DIRECTORY_HEADER] = encodeURIComponent(options.directory);

  // The generated client captures headers at construction time, so a config
  // change has to rebuild it (v1 mutated config in place).
  let raw = OpenCode.make({ baseUrl, headers });
  const rebuild = () => { raw = OpenCode.make({ baseUrl, headers }); };

  const turnWaiters = new Map();   // sessionID → Set<{ settled, resolve }>
  const textAccum = new Map();     // sessionID → streamed assistant text
  const toolNames = new Map();     // tool call id → tool name
  const formRegistry = new Map();  // formID → { sessionID, fields }
  const permSessions = new Map();  // permission requestID → sessionID

  function registerTurn(sessionID) {
    const entry = { settled: false };
    const promise = new Promise((resolve) => { entry.resolve = resolve; });
    let set = turnWaiters.get(sessionID);
    if (!set) { set = new Set(); turnWaiters.set(sessionID, set); }
    set.add(entry);
    return {
      promise,
      cancel() {
        if (entry.settled) return;
        entry.settled = true;
        const s = turnWaiters.get(sessionID);
        if (s) { s.delete(entry); if (s.size === 0) turnWaiters.delete(sessionID); }
      },
    };
  }

  function settleTurn(sessionID) {
    const set = turnWaiters.get(sessionID);
    if (!set) return;
    turnWaiters.delete(sessionID);
    for (const entry of set) {
      if (!entry.settled) { entry.settled = true; entry.resolve(); }
    }
  }

  /** v2 wire event → the v1 `{ type, id, properties }` envelope. */
  function translate(event) {
    const type = event?.type;
    const d = event?.data || {};
    const id = event?.id;
    const created = event?.created ?? Date.now();

    switch (type) {
      case 'tui.session.select':
        return { type, id, properties: { sessionID: d.sessionID ?? d.id, id: d.id ?? d.sessionID } };
      case 'session.created':
        return {
          type,
          id,
          properties: {
            sessionID: d.sessionID ?? d.id,
            id: d.sessionID ?? d.id,
            directory: d.location?.directory,
          },
        };

      case 'session.status':
        return { type, id, properties: { sessionID: d.sessionID, status: d.status } };
      case 'session.idle':
        settleTurn(d.sessionID);
        return { type, id, properties: { sessionID: d.sessionID } };
      case 'session.execution.started':
        return { type: 'session.status', id, properties: { sessionID: d.sessionID, status: { type: 'busy' } } };
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
        settleTurn(d.sessionID);
        return { type: 'session.idle', id, properties: { sessionID: d.sessionID } };
      case 'session.execution.failed':
        settleTurn(d.sessionID);
        return { type: 'session.error', id, properties: { sessionID: d.sessionID, error: toV1Error(d.error) } };

      case 'session.text.delta':
        textAccum.set(d.sessionID, (textAccum.get(d.sessionID) || '') + (d.delta || ''));
        return { type: 'message.part.delta', id, properties: { sessionID: d.sessionID, field: 'text', delta: d.delta } };
      case 'session.reasoning.delta':
        return { type: 'message.part.delta', id, properties: { sessionID: d.sessionID, field: 'reasoning', delta: d.delta } };
      case 'session.reasoning.started':
        return {
          type: 'message.part.updated',
          id,
          properties: {
            sessionID: d.sessionID,
            field: 'reasoning',
            part: { id: `${d.assistantMessageID}:reason`, type: 'reasoning', time: { start: created } },
          },
        };
      case 'session.reasoning.ended':
        return {
          type: 'message.part.updated',
          id,
          properties: {
            sessionID: d.sessionID,
            field: 'reasoning',
            part: { id: `${d.assistantMessageID}:reason`, type: 'reasoning', time: { end: created } },
          },
        };

      case 'session.tool.input.started':
        toolNames.set(d.id, d.name);
        return {
          type: 'message.part.updated',
          id,
          properties: {
            sessionID: d.sessionID,
            // the adapter reads `part.input` (top level), keeps `state` too
            part: { id: d.id, type: 'tool', tool: d.name, input: {}, state: { status: 'running' }, time: { start: created } },
          },
        };
      case 'session.tool.called':
        return {
          type: 'message.part.updated',
          id,
          properties: {
            sessionID: d.sessionID,
            part: {
              id: d.id,
              type: 'tool',
              tool: toolNames.get(d.id) || '',
              input: d.input,
              state: { status: 'running', input: d.input },
            },
          },
        };
      case 'session.tool.success': {
        const name = toolNames.get(d.id) || '';
        toolNames.delete(d.id);
        return {
          type: 'message.part.updated',
          id,
          properties: {
            sessionID: d.sessionID,
            part: {
              id: d.id,
              type: 'tool',
              tool: name,
              state: { status: 'completed', output: toolOutputText(d.content) },
              time: { end: created },
            },
          },
        };
      }
      case 'session.tool.failed': {
        const name = toolNames.get(d.id) || '';
        toolNames.delete(d.id);
        return {
          type: 'message.part.updated',
          id,
          properties: {
            sessionID: d.sessionID,
            part: {
              id: d.id,
              type: 'tool',
              tool: name,
              state: { status: 'error', output: errorText(d.error) || toolOutputText(d.content) },
              time: { end: created },
            },
          },
        };
      }

      case 'permission.asked':
        permSessions.set(d.id, d.sessionID);
        return {
          type,
          id,
          properties: {
            sessionID: d.sessionID,
            id: d.id,
            requestID: d.id,
            permission: d.action,
            action: d.action,
            patterns: d.resources,
            resources: d.resources,
            metadata: d.metadata,
            source: d.source,
            message: d.message,
          },
        };
      case 'permission.replied':
        permSessions.delete(d.requestID);
        return { type, id, properties: { sessionID: d.sessionID, requestID: d.requestID, reply: d.reply } };

      case 'form.created': {
        const form = d.form || {};
        formRegistry.set(form.id, { sessionID: form.sessionID, fields: form.fields });
        return {
          type: 'question.asked',
          id,
          properties: {
            sessionID: form.sessionID,
            requestID: form.id,
            id: form.id,
            questions: formToQuestions(form),
          },
        };
      }
      case 'form.replied':
        formRegistry.delete(d.id);
        return { type: 'question.replied', id, properties: { sessionID: d.sessionID, requestID: d.id, id: d.id } };
      case 'form.cancelled':
        formRegistry.delete(d.id);
        return { type: 'question.rejected', id, properties: { sessionID: d.sessionID, requestID: d.id, id: d.id } };

      default:
        return null;
    }
  }

  async function* translatedStream(iterator, first) {
    try {
      let cur = first;
      while (!cur.done) {
        const t = translate(cur.value);
        if (t) yield t;
        cur = await iterator.next();
      }
    } finally {
      if (typeof iterator.return === 'function') {
        try { await iterator.return(); } catch { /* already closed */ }
      }
    }
  }

  const session = {
    async list(input = {}) {
      const res = await raw.session.list({
        limit: input?.limit,
        directory: input?.directory,
        search: input?.search,
        cursor: input?.cursor,
      });
      return { data: (res?.data || []).map(mapSession) };
    },

    async get(input) {
      return { data: mapSession(await raw.session.get({ sessionID: input.sessionID })) };
    },

    async create(input = {}) {
      const created = await raw.session.create({
        title: input?.title,
        location: input?.directory ? { directory: input.directory } : undefined,
      });
      return { data: mapSession(created) };
    },

    /** v1 `status()` returned the busy map; v2 `active()` returns only running. */
    async status() {
      const active = await raw.session.active();
      const data = {};
      for (const sid of Object.keys(active || {})) data[sid] = { type: 'busy' };
      return { data };
    },

    async abort(input) {
      await raw.session.interrupt({ sessionID: input.sessionID });
      return { data: true };
    },

    /**
     * v1 prompt resolved when the whole turn finished. v2 admits the message
     * to the inbox and returns at once, so block here until the turn's
     * terminal event to preserve the adapter's completion semantics.
     */
    async prompt(input, requestOptions) {
      const sessionID = input?.sessionID;
      if (input?.agent) {
        try { await raw.session.switchAgent({ sessionID, agent: input.agent }); } catch { /* keep going */ }
      }
      if (input?.model) {
        try { await raw.session.switchModel({ sessionID, model: toModelRef(input.model) }); } catch { /* keep going */ }
      }

      textAccum.set(sessionID, '');
      const turn = registerTurn(sessionID);
      try {
        await raw.session.prompt({ sessionID, text: partsToText(input?.parts) });
      } catch (e) {
        turn.cancel();
        return { error: errBody(e) };
      }

      try {
        await raceAbort(turn.promise, requestOptions?.signal);
      } catch (e) {
        turn.cancel();
        throw e;
      }

      const accumulated = textAccum.get(sessionID) || '';
      return { data: { parts: accumulated ? [{ type: 'text', text: accumulated }] : [] } };
    },

    /** v1 `revert({sessionID})` undid the last message; v2 reverts at a messageID. */
    async revert(input) {
      const messages = await raw.session.context({ sessionID: input.sessionID });
      const lastUser = [...(messages || [])].reverse().find((m) => m?.type === 'user');
      if (!lastUser?.id) throw new Error('没有可撤销的消息');
      return { data: await raw.session.revert.stage({ sessionID: input.sessionID, messageID: lastUser.id }) };
    },

    async unrevert(input) {
      await raw.session.revert.clear({ sessionID: input.sessionID });
      return { data: undefined };
    },
  };

  const permission = {
    async list() {
      const res = await raw.permission.request.list();
      const data = (res?.data || []).map((r) => ({
        id: r.id,
        sessionID: r.sessionID ?? permSessions.get(r.id),
        permission: r.action,
        patterns: r.resources,
        resources: r.resources,
        metadata: r.metadata,
      }));
      return { data };
    },

    async reply(input) {
      let sessionID = permSessions.get(input.requestID);
      if (!sessionID) {
        const res = await raw.permission.request.list().catch(() => null);
        sessionID = (res?.data || []).find((r) => r.id === input.requestID)?.sessionID;
      }
      if (!sessionID) throw new Error('未知会话，无法提交权限回复');
      await raw.permission.reply({
        sessionID,
        requestID: input.requestID,
        decision: input.reply,
        message: input.message,
      });
      permSessions.delete(input.requestID);
      return { data: true };
    },
  };

  async function findForm(formID) {
    const cached = formRegistry.get(formID);
    if (cached?.sessionID) return cached;
    const res = await raw.form.list().catch(() => null);
    const form = (res?.data || []).find((f) => f.id === formID);
    if (!form) return null;
    const entry = { sessionID: form.sessionID, fields: form.fields };
    formRegistry.set(form.id, entry);
    return entry;
  }

  const question = {
    async list() {
      const res = await raw.form.list();
      const forms = res?.data || [];
      for (const f of forms) formRegistry.set(f.id, { sessionID: f.sessionID, fields: f.fields });
      return {
        data: forms.map((f) => ({
          id: f.id,
          requestID: f.id,
          sessionID: f.sessionID,
          questions: formToQuestions(f),
        })),
      };
    },

    async reply(input) {
      const entry = await findForm(input.requestID);
      if (!entry) return { error: errBody(new Error('未找到该表单')) };
      const answers = (input.answers || []).map((a) => (Array.isArray(a) ? a.join(', ') : a));
      await raw.session.form.reply({
        sessionID: entry.sessionID,
        formID: input.requestID,
        answer: answersToFormAnswer(entry.fields, answers),
      });
      formRegistry.delete(input.requestID);
      return { data: true };
    },

    async reject(input) {
      const entry = await findForm(input.requestID);
      if (!entry) return { data: true };
      await raw.session.form.cancel({ sessionID: entry.sessionID, formID: input.requestID });
      formRegistry.delete(input.requestID);
      return { data: true };
    },
  };

  const project = {
    async list() {
      return { data: (await raw.project.list()) || [] };
    },

    async directories(input) {
      const projects = (await raw.project.list().catch(() => [])) || [];
      const p = projects.find((x) => x.id === input?.projectID);
      const dirs = [];
      if (p?.canonical) dirs.push({ directory: p.canonical });
      for (const sandbox of p?.sandboxes || []) dirs.push({ directory: sandbox });
      return { data: dirs };
    },
  };

  const config = {
    /**
     * v1 returned providers with a `models` map; v2 keeps models separate, so
     * join them back here (handleModels prints `Object.keys(p.models)`).
     */
    async providers() {
      const [provRes, modelRes] = await Promise.all([
        raw.provider.list(),
        raw.model.list().catch(() => null),
      ]);
      const byProvider = new Map();
      for (const m of modelRes?.data || []) {
        const key = m.providerID;
        if (!byProvider.has(key)) byProvider.set(key, {});
        byProvider.get(key)[m.modelID || m.id] = m;
      }
      const providers = (provRes?.data || []).map((p) => ({
        id: p.id,
        providerID: p.id,
        name: p.name,
        models: byProvider.get(p.id) || {},
      }));
      return { data: { providers } };
    },
  };

  // v1 nested these under a `v2` namespace; keep it for the call sites.
  const v2 = {
    model: {
      async list() {
        const res = await raw.model.list();
        return { data: res?.data || [] };
      },
    },
    session: {
      async compact(input) {
        return { data: await raw.session.compact({ sessionID: input.sessionID }) };
      },
    },
  };

  const event = {
    async subscribe(input, requestOptions) {
      const ro = { ...(requestOptions || {}) };
      if (input?.directory) {
        ro.headers = { ...(ro.headers || {}), [DIRECTORY_HEADER]: encodeURIComponent(input.directory) };
      }
      const iterator = raw.event.subscribe(ro)[Symbol.asyncIterator]();
      // Pull the first event before resolving, so the adapter's connect
      // timeout still aborts a hung connection.
      const first = await iterator.next();
      return { stream: translatedStream(iterator, first) };
    },
  };

  const client = {
    getConfig() {
      return { baseUrl, headers: { ...headers } };
    },
    setConfig(next) {
      if (next?.headers) {
        headers = { ...next.headers };
        rebuild();
      }
      return client.getConfig();
    },
  };

  return { session, permission, question, project, config, v2, event, client };
}
