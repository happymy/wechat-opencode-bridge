import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

const TOKEN_FILE_DEFAULT = join(homedir(), '.wechat-acp', 'token.json');
const CHANNEL_VERSION = '1.0.2';

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
    console.log(`
iLink 限流测试脚本

用法:
  node test-iLink-rate-limit.js <context_token> <user_id> [选项]

必填:
  context_token  从 bot 日志中获取
  user_id        用户微信 ID

选项:
  --start-rate <N>   起始频率 (次/秒), 默认 1
  --max-rate <N>     最大频率, 默认 20
  --step <N>         每次递增, 默认 1
  --per-step <N>     每级发送消息数, 默认 3
  --msg <text>       测试消息内容
  --base-url <url>   iLink API 地址
  --token-file <path> token 文件路径
  --safe             遇到 ret=-2 自动停止 (默认)
  --no-safe          忽略限流继续测试
  --interval <ms>    固定间隔模式
  --dry-run          只打印请求参数
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

function loadToken(filePath) {
  if (!existsSync(filePath)) {
    console.error(`Token 文件不存在: ${filePath}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`Token 文件解析失败: ${err.message}`);
    process.exit(1);
  }
}

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
      message_type: 2,
      message_state: 2,
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
  try { parsed = JSON.parse(bodyText); } catch { parsed = null; }
  const ret = parsed?.base_info?.ret;
  const errMsg = parsed?.base_info?.err_msg || error || '';

  return { httpStatus, duration, ret, errMsg, body: bodyText, startTime: new Date(startTime).toISOString() };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const config = parseArgs();
  const token = loadToken(config.tokenFile);
  const baseUrl = config.baseUrl || `https://${token.domain}`;
  const accessToken = token.access_token;
  const clientId = crypto.randomUUID();

  console.log(`\n=== iLink 限流测试 ===`);
  console.log(`  Context Token: ${config.contextToken.slice(0, 20)}...`);
  console.log(`  UserID:        ${config.userId}`);
  console.log(`  Base URL:      ${baseUrl}`);
  console.log(`  Safe mode:     ${config.safe}`);
  console.log(`  Dry run:       ${config.dryRun}`);
  console.log('');

  if (config.interval) {
    console.log(`固定间隔模式: 每 ${config.interval}ms 发一条\n`);
    let count = 0;
    while (true) {
      count++;
      if (config.dryRun) {
        console.log(`[${count}] DRY RUN - would send: "${config.msg}"`);
      } else {
        const result = await callSendMessage(baseUrl, accessToken, config.userId, config.contextToken, `[${count}] ${config.msg}`, clientId);
        const retStr = result.ret !== undefined ? `ret=${result.ret}` : `http=${result.httpStatus}`;
        console.log(`[${count}] ${retStr} ${result.duration}ms ${result.errMsg.slice(0, 60)}`);
        if (config.safe && result.ret === -2) {
          console.log('\n检测到 ret=-2 (限流)，自动停止');
          break;
        }
      }
      await sleep(config.interval);
    }
  } else {
    console.log(`递增频率模式: ${config.startRate} → ${config.maxRate} 次/秒 (步进 ${config.step})`);
    console.log(`每级发送 ${config.perStep} 条\n`);

    let total = 0;
    for (let rate = config.startRate; rate <= config.maxRate; rate += config.step) {
      const intervalMs = Math.round(1000 / rate);
      console.log(`频率 ${rate}次/秒 (间隔 ${intervalMs}ms) ───`);
      for (let i = 0; i < config.perStep; i++) {
        total++;
        if (config.dryRun) {
          console.log(`  [${total}] DRY RUN - would send: "${config.msg}"`);
        } else {
          const result = await callSendMessage(baseUrl, accessToken, config.userId, config.contextToken, `[${total} @${rate}/s] ${config.msg}`, clientId);
          const retStr = result.ret !== undefined ? `ret=${result.ret}` : `http=${result.httpStatus}`;
          console.log(`  [${total}] ${retStr} ${result.duration}ms ${result.errMsg.slice(0, 60)}`);
          if (config.safe && result.ret === -2) {
            console.log('\n检测到 ret=-2 (限流)，自动停止');
            process.exit(0);
          }
        }
        await sleep(intervalMs);
      }
    }
    console.log('\n测试完成，未触发限流');
  }
}

main().catch(console.error);
