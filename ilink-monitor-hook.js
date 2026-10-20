/**
 * iLink API 被动嗅探模块
 * 用法: node --import ./ilink-monitor-hook.js <wechat-acp桥接命令>
 * 拦截所有 iLink API 调用，记录请求/响应到日志文件
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = join(homedir(), '.wechat-acp', 'ilink-monitor');
const LOG_FILE = join(LOG_DIR, `ilink-${new Date().toISOString().slice(0, 10)}.log`);

mkdirSync(LOG_DIR, { recursive: true });

function log(msg) {
  const ts = new Date().toISOString();
  try { appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch {}
}

log('=== iLink Monitor Hook Loaded ===');

const originalFetch = globalThis.fetch;

globalThis.fetch = async function interceptedFetch(url, options) {
  const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url?.url || String(url);
  const isILink = urlStr.includes('ilink/');

  if (!isILink) {
    return originalFetch.call(this, url, options);
  }

  const endpoint = urlStr.split('ilink/')[1] || urlStr;
  const startTime = Date.now();

  // 记录请求体 (截断敏感信息)
  let reqBodyBrief = '';
  if (options?.body && endpoint.includes('sendmessage')) {
    try {
      const parsed = JSON.parse(options.body);
      const ctx = parsed?.msg?.context_token || '';
      const text = parsed?.msg?.item_list?.[0]?.text_item?.text || '';
      reqBodyBrief = ` ctx=${ctx.slice(0, 200)} text=${text.slice(0, 80)}`;
    } catch {}
  }
  log(`>>> ${endpoint}${reqBodyBrief}`);

  let response;
  try {
    response = await originalFetch.call(this, url, options);
  } catch (err) {
    const duration = Date.now() - startTime;
    log(`<<< ${endpoint} ERROR duration=${duration}ms error=${err.message}`);
    throw err;
  }

  const duration = Date.now() - startTime;
  const cloned = response.clone();
  const bodyText = await cloned.text().catch(() => '<read-error>');

  log(`<<< ${endpoint} status=${response.status} duration=${duration}ms body=${bodyText.slice(0, 500)}`);

  return response;
};

log('=== iLink Monitor Hook Active ===');
