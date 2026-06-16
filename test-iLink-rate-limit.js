/**
 * iLink 限流测试脚本
 *
 * 用法:
 *   node test-iLink-rate-limit.js <context_token> <user_id>
 *
 * 可选参数:
 *   --start-rate <N>   起始频率 (次/秒), 默认 1
 *   --max-rate <N>     最大频率, 默认 20
 *   --step <N>         每次递增, 默认 1
 *   --per-step <N>     每级发送消息数, 默认 3
 *   --msg <text>       测试消息内容, 默认 "[测试] iLink 限流探测"
 *   --base-url <url>   iLink API 地址, 默认从 token 获取
 *   --token-file <path> token 文件路径, 默认 ~/.wechat-acp/token.json
 *   --safe             遇到 ret=-2 自动停止 (默认开启)
 *   --no-safe          忽略限流继续测试
 *   --interval         固定间隔模式: 每隔 N ms 发一条
 *   --dry-run          只打印请求参数, 不实际发送
 *
 * 前置条件:
 *   1. 从 bot 日志中找到 context_token 和 user_id
 *   2. 确保 wechat-acp token 未过期
 *
 * 安全说明:
 *   - 测试消息会发送到用户手机
 *   - --safe 模式下出现 ret=-2 自动停止
 *   - 建议给自己的测试号发送
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import crypto from 'node:crypto';

/* ───────── 配置 ───────── */

const TOKEN_FILE_DEFAULT = join(homedir(), '.wechat-acp', 'token.json');
const REPORT_DIR = join(homedir(), '.wechat-acp', 'ilink-tests');
const CHANNEL_VERSION = '1.0.2';

/* ───────── CLI 解析 ───────── */

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
    console.log(`
iLink 限流测试脚本

用法:
  node test-iLink-rate-limit.js <context_token> <user_id> [选项]

必填:
  context_token  从 bot 日志中获取 (Message from xxx: ...)
  user_id        用户微信 ID

选项:
  --start-rate <N>   起始频率 (次/秒), 默认 1
  --max-rate <N>     最大频率, 默认 20
  --step <N>         每次递增, 默认 1
  --per-step <N>     每级发送消息数, 默认 3
  --msg <text>       测试消息内容, 默认 "[测试] iLink 限流探测"
  --base-url <url>   iLink API 地址, 默认从 token 获取
  --token-file <path> token 文件路径, 默认 ~/.wechat-acp/token.json
  --safe             遇到 ret=-2 自动停止 (默认)
  --no-safe          继续测试不停止
  --interval <ms>    固定间隔模式: 每隔 N ms 发一条 (替代递增模式)
  --dry-run          只打印请求参数, 不实际发送
  -h, --help         显示帮助

示例:
  node test-iLink-rate-limit.js ctx_abc123 wx_user_001
  node test-iLink-rate-limit.js ctx_abc123 wx_user_001 --start-rate 2 --max-rate 10
  node test-iLink-rate-limit.js ctx_abc123 wx_user_001 --interval 200
  node test-iLink-rate-limit.js ctx_abc123 wx_user_001 --dry-run
`);
    process.exit(0);
  }

  const result = {
    contextToken: args[0],
    userId: args[1],
    startRate: 1,
    maxRate: 20,
    step: 1,
    perStep: 3,
    msg: '[测试] iLink 限流探测',
    baseUrl: null,
    tokenFile: TOKEN_FILE_DEFAULT,
    safe: true,
    interval: null,
    dryRun: false,
  };

  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
      case '--start-rate': result.startRate = parseInt(args[++i], 10); break;
      case '--max-rate': result.maxRate = parseInt(args[++i], 10); break;
      case '--step': result.step = parseInt(args[++i], 10); break;
      case '--per-step': result.perStep = parseInt(args[++i], 10); break;
      case '--msg': result.msg = args[++i]; break;
      case '--base-url': result.baseUrl = args[++i]; break;
      case '--token-file': result.tokenFile = args[++i]; break;
      case '--no-safe': result.safe = false; break;
      case '--interval': result.interval = parseInt(args[++i], 10); break;
      case '--dry-run': result.dryRun = true; break;
    }
  }

  return result;
}

/* ───────── Token 加载 ───────── */

function loadToken(filePath) {
  if (!existsSync(filePath)) {
    console.error(`❌ Token 文件不存在: ${filePath}`);
    console.error('   请确保 wechat-acp 已登录');
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`❌ Token 文件解析失败: ${err.message}`);
    process.exit(1);
  }
}

/* ───────── HTTP 调用 ───────── */

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

async function callSendMessage(baseUrl, token, userId, contextToken, text, clientId) {
  const url = `${baseUrl.replace(/\/+$/, '')}/ilink/bot/sendmessage`;

  const body = {
    msg: {
      from_user_id: '',
      to_user_id: userId,
      client_id: clientId,
      message_type: 2,    // BOT
      message_state: 2,   // FINISH
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: CHANNEL_VERSION },
  };

  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    Authorization: `Bearer ${token}`,
  };

  const startTime = Date.now();

  let httpStatus, bodyText, error;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    httpStatus = res.status;
    bodyText = await res.text();
  } catch (err) {
    error = err.message;
    httpStatus = 0;
  }

  const duration = Date.now() - startTime;

  let parsed;
  try { parsed = JSON.parse(bodyText || '{}'); } catch { parsed = {}; }

  return {
    httpStatus,
    ret: parsed.ret,
    errcode: parsed.errcode,
    errmsg: parsed.errmsg,
    bodyRaw: bodyText,
    duration,
    error,
    sentAt: new Date().toISOString(),
  };
}

/* ───────── 报告输出 ───────── */

function initReport(opts) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(REPORT_DIR, `ilink-test-${ts}.json`);
  const meta = {
    filePath,
    startTime: ts,
    hostname: hostname(),
    opts: {
      contextToken: opts.contextToken.slice(0, 16) + '...',
      userId: opts.userId.slice(0, 12) + '...',
      startRate: opts.startRate,
      maxRate: opts.maxRate,
      step: opts.step,
      perStep: opts.perStep,
      msg: opts.msg,
      safe: opts.safe,
      interval: opts.interval,
    },
    results: [],
    summary: null,
  };
  return { filePath, meta };
}

function appendResult(meta, result) {
  meta.results.push(result);
  // 每 50 条刷一次磁盘
  if (meta.results.length % 50 === 0) {
    try { appendFileSync(meta.filePath, ''); } catch {}
  }
}

function writeReport(meta) {
  const summary = generateSummary(meta);
  meta.summary = summary;
  try {
    const { filePath: fp, ...data } = meta;
    const report = JSON.stringify(data, null, 2);
    const tmpPath = fp + '.tmp';
    writeFileSync(tmpPath, report, 'utf-8');
    renameSync(tmpPath, fp);
    console.log(`\n📄 完整报告已保存: ${fp}`);
  } catch (err) {
    console.error(`⚠️ 报告保存失败: ${err.message}`);
  }
}

/* ───────── 报告打印 ───────── */

function generateSummary(meta) {
  const results = meta.results;
  const total = results.length;
  if (total === 0) return { total: 0 };

  const succeeded = results.filter(r => r.ret === 0 || r.ret === undefined).length;
  const rateLimited = results.filter(r => r.ret === -2 || (r.httpStatus === 429)).length;
  const errored = results.filter(r => r.error || r.httpStatus >= 400).length;

  const rates = new Set(results.map(r => r.targetRate).filter(Boolean));
  const sortedRates = [...rates].sort((a, b) => a - b);

  const perRate = {};
  for (const rate of sortedRates) {
    const atRate = results.filter(r => r.targetRate === rate);
    const success = atRate.filter(r => r.ret === 0 || r.ret === undefined).length;
    const limited = atRate.filter(r => r.ret === -2).length;
    perRate[rate] = { total: atRate.length, success, limited };
  }

  // 找首次限流
  const firstLimit = results.find(r => r.ret === -2);
  const first429 = results.find(r => r.httpStatus === 429);

  return {
    total,
    succeeded,
    rateLimited,
    errored,
    firstRateLimitAt: firstLimit
      ? `第 ${firstLimit.index + 1} 次调用 (${firstLimit.targetRate}次/秒, ${firstLimit.sentAt})`
      : '未触发',
    firstHttp429At: first429
      ? `第 ${first429.index + 1} 次调用 (${first429.targetRate}次/秒)`
      : '未触发',
    perRate,
    allResults: results.map(r => ({
      index: r.index + 1,
      targetRate: r.targetRate,
      httpStatus: r.httpStatus,
      ret: r.ret,
      errcode: r.errcode,
      errmsg: r.errmsg,
      duration: r.duration + 'ms',
      error: r.error || null,
      sentAt: r.sentAt,
    })),
  };
}

function printReport(summary) {
  console.log('\n═══════════════════════════════════════');
  console.log('         iLink 限流测试报告');
  console.log('═══════════════════════════════════════');
  console.log(`总调用:  ${summary.total}`);
  console.log(`成功:    ${summary.succeeded}`);
  console.log(`限流:    ${summary.rateLimited}`);
  console.log(`错误:    ${summary.errored}`);
  console.log('');
  console.log(`首次限流: ${summary.firstRateLimitAt}`);
  console.log(`首次 429: ${summary.firstHttp429At}`);
  console.log('');

  if (summary.perRate && Object.keys(summary.perRate).length > 0) {
    console.log('每级频率统计:');
    console.log('  频率\t总调用\t成功\t限流');
    for (const [rate, info] of Object.entries(summary.perRate)) {
      console.log(`  ${rate}次/秒\t${info.total}\t${info.success}\t${info.limited}`);
    }
    console.log('');
  }

  if (summary.allResults) {
    console.log('详细记录:');
    for (const r of summary.allResults) {
      const status = r.ret === 0 || r.ret === undefined ? '✅' :
                     r.ret === -2 ? '❌限流' :
                     r.httpStatus === 429 ? '❌429' :
                     r.error ? `❌${r.error.slice(0, 30)}` : '⚠️';
      console.log(`  #${String(r.index).padStart(3)} ${r.targetRate}次/s ${status} HTTP=${r.httpStatus} ret=${r.ret ?? '-'} errcode=${r.errcode ?? '-'} errmsg=${r.errmsg ?? '-'} ${r.duration}`);
    }
  }
}

/* ───────── 主流程 ───────── */

async function main() {
  const opts = parseArgs();

  console.log('═══════════════════════════════════════');
  console.log('         iLink 限流测试');
  console.log('═══════════════════════════════════════');
  console.log(`  context_token: ${opts.contextToken.slice(0, 20)}...`);
  console.log(`  user_id:       ${opts.userId.slice(0, 12)}...`);
  console.log(`  安全模式:      ${opts.safe ? '开启 (遇到 ret=-2 停止)' : '关闭'}`);
  if (opts.interval) {
    console.log(`  模式:          固定间隔 ${opts.interval}ms`);
  } else {
    console.log(`  起始频率:      ${opts.startRate} 次/秒`);
    console.log(`  最大频率:      ${opts.maxRate} 次/秒`);
    console.log(`  步进:          ${opts.step}`);
    console.log(`  每级消息数:    ${opts.perStep}`);
  }
  console.log(`  消息内容:      "${opts.msg}"`);
  console.log('');

  // 加载 token
  const token = loadToken(opts.tokenFile);
  const baseUrl = opts.baseUrl || token.baseUrl;
  console.log(`  baseUrl: ${baseUrl}`);
  console.log(`  token:   ${token.token ? token.token.slice(0, 16) + '...' : '无'}`);
  console.log(`  account: ${token.accountId || '未知'}`);
  console.log('');

  if (!token.token) {
    console.error('❌ token 文件中没有有效的 token');
    process.exit(1);
  }
  if (!baseUrl) {
    console.error('❌ 无法确定 baseUrl');
    process.exit(1);
  }

  // 初始化报告
  const { filePath, meta } = initReport(opts);
  console.log(`📄 报告将保存到: ${filePath}\n`);

  if (opts.dryRun) {
    console.log('═══ --dry-run 模式 ═══');
    console.log('HTTP POST 请求参数:');
    console.log(JSON.stringify({
      url: `${baseUrl.replace(/\/+$/, '')}/ilink/bot/sendmessage`,
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': '<random>',
        Authorization: `Bearer ${token.token.slice(0, 16)}...`,
      },
      body: {
        msg: {
          from_user_id: '',
          to_user_id: opts.userId,
          client_id: '<uuid>',
          message_type: 2,
          message_state: 2,
          context_token: opts.contextToken.slice(0, 20) + '...',
          item_list: [{ type: 1, text_item: { text: opts.msg } }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      },
    }, null, 2));
    console.log('\n📌 --dry-run 模式，未发送任何请求');
    process.exit(0);
  }

  // 先发一条验证连通性
  console.log('⏳ 发送验证消息...');
  const probeId = `test-probe-${crypto.randomUUID()}`;
  const probeResult = await callSendMessage(baseUrl, token.token, opts.userId, opts.contextToken, `[连通性测试] ${new Date().toISOString()}`, probeId);
  console.log(`  连通性测试: HTTP=${probeResult.httpStatus} ret=${probeResult.ret ?? '-'} errcode=${probeResult.errcode ?? '-'} errmsg=${probeResult.errmsg ?? '-'} duration=${probeResult.duration}ms`);
  console.log('');

  if (probeResult.error || probeResult.httpStatus >= 400) {
    console.error('❌ 连通性测试失败，请检查参数');
    console.error(`   ${probeResult.error || `HTTP ${probeResult.httpStatus}: ${probeResult.bodyRaw}`}`);
    process.exit(1);
  }

  let totalSent = 0;
  let rateLimitedCount = 0;

  if (opts.interval) {
    // ─── 固定间隔模式 ───
    const intervalMs = opts.interval;
    const rate = 1000 / intervalMs;
    console.log(`⏳ 固定间隔 ${intervalMs}ms (约 ${rate.toFixed(1)} 次/秒), 持续发送直到手动 Ctrl+C 或触发限流`);
    console.log('');

    while (true) {
      const clientId = `test-rate-${crypto.randomUUID()}`;
      const result = await callSendMessage(baseUrl, token.token, opts.userId, opts.contextToken, opts.msg, clientId);
      result.index = totalSent;
      result.targetRate = rate;

      const status = result.ret === 0 || result.ret === undefined ? '✅' :
                     result.ret === -2 ? '❌限流' :
                     result.error ? `❌${result.error.slice(0, 30)}` : '⚠️';
      process.stdout.write(`  #${totalSent + 1} ${status} HTTP=${result.httpStatus} ret=${result.ret ?? '-'} errmsg=${result.errmsg ?? '-'} ${result.duration}ms\n`);

      appendResult(meta, result);
      totalSent++;

      if (result.ret === -2) {
        rateLimitedCount++;
        if (opts.safe) {
          console.log(`\n⚠️ 触发限流 (ret=-2)，安全模式自动停止`);
          console.log(`   共发送 ${totalSent} 条，其中 ${rateLimitedCount} 条被限流`);
          break;
        }
      }

      await new Promise(r => setTimeout(r, intervalMs));
    }
  } else {
    // ─── 递增频率模式 ───
    for (let rate = opts.startRate; rate <= opts.maxRate; rate += opts.step) {
      const intervalMs = 1000 / rate;
      console.log(`\n─── 测试 ${rate} 次/秒 (间隔 ${intervalMs.toFixed(0)}ms) ───`);

      for (let i = 0; i < opts.perStep; i++) {
        const clientId = `test-rate-${crypto.randomUUID()}`;
        const result = await callSendMessage(baseUrl, token.token, opts.userId, opts.contextToken, opts.msg, clientId);
        result.index = totalSent;
        result.targetRate = rate;

        const status = result.ret === 0 || result.ret === undefined ? '✅' :
                       result.ret === -2 ? '❌限流' :
                       result.error ? `❌${result.error.slice(0, 30)}` : '⚠️';
        process.stdout.write(`  #${totalSent + 1} ${status} HTTP=${result.httpStatus} ret=${result.ret ?? '-'} errcode=${result.errcode ?? '-'} errmsg=${result.errmsg ?? '-'} ${result.duration}ms\n`);

        appendResult(meta, result);
        totalSent++;

        if (result.ret === -2) {
          rateLimitedCount++;
          if (opts.safe) {
            console.log(`\n⚠️ 触发限流 (ret=-2)，安全模式自动停止`);
            console.log(`   频率: ${rate}次/秒, 第 ${i + 1}/${opts.perStep} 条`);
            break;
          }
        }

        // 频率控制
        if (i < opts.perStep - 1) {
          await new Promise(r => setTimeout(r, intervalMs));
        }
      }

      if (opts.safe && rateLimitedCount > 0) break;
    }
  }

  // 恢复期观察
  if (rateLimitedCount > 0) {
    console.log('\n─── 恢复期观察 (15秒后重新探测) ───');
    await new Promise(r => setTimeout(r, 15000));
    console.log('⏳ 恢复探测...');
    const recoveryId = `test-recovery-${crypto.randomUUID()}`;
    const recoveryResult = await callSendMessage(baseUrl, token.token, opts.userId, opts.contextToken, '[恢复探测] ' + new Date().toISOString(), recoveryId);
    const recoveryStatus = recoveryResult.ret === 0 || recoveryResult.ret === undefined ? '✅ 已恢复' :
                           recoveryResult.ret === -2 ? '❌ 仍限流' : '⚠️';
    console.log(`  ${recoveryStatus} HTTP=${recoveryResult.httpStatus} ret=${recoveryResult.ret ?? '-'} duration=${recoveryResult.duration}ms`);

    if (recoveryResult.ret === -2) {
      // 继续等待
      console.log('⏳ 继续等待 30秒...');
      await new Promise(r => setTimeout(r, 30000));
      const recoveryResult2 = await callSendMessage(baseUrl, token.token, opts.userId, opts.contextToken, '[恢复探测2] ' + new Date().toISOString(), `test-recovery2-${crypto.randomUUID()}`);
      const recoveryStatus2 = recoveryResult2.ret === 0 || recoveryResult2.ret === undefined ? '✅ 已恢复' :
                              recoveryResult2.ret === -2 ? '❌ 仍限流' : '⚠️';
      console.log(`  ${recoveryStatus2} HTTP=${recoveryResult2.httpStatus} ret=${recoveryResult2.ret ?? '-'} duration=${recoveryResult2.duration}ms`);
    }
  }

  // 输出报告
  const summary = generateSummary(meta);
  meta.summary = summary;
  writeReport(meta);
  printReport(summary);

  console.log('\n✅ 测试完成');
}

main().catch(err => {
  console.error(`\n❌ 测试异常: ${err.message}`);
  process.exit(1);
});
