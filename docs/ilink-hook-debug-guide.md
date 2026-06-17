# iLink 限流调试手册

## 问题背景

iLink（微信公众号/订阅号 Bot API）对每个 `context_token` 有约 5 次 `sendmessage` 调用配额。超出后返回 `HTTP 200 + {"ret":-2}`，**永不自动恢复**，直到用户发新消息刷新 `context_token`。

FULL 模式（实时流式输出）天然需要多次 API 调用，容易触限。

## 工具链

```
ilink-monitor-hook.js       # 被动嗅探：hook fetch，记录所有 iLink API 调用
test-iLink-rate-limit.js    # 主动测试：递增频率或固定间隔调用，探测限流阈值
restart-wechat-monitor.bat  # 一键重启桥接 + 加载嗅探模块
```

## 被动嗅探（日常调试）

### 启动

```bash
restart-wechat-monitor.bat
```

底层执行：
```bash
node --import file:///path/to/ilink-monitor-hook.js node_modules/wechat-acp/dist/bin/wechat-acp.js --agent "node wechat-adapter.js" --cwd <工作目录>
```

关键：`--import` 在 Node 加载主模块前注入 `ilink-monitor-hook.js`，hook 全局 `fetch`。

### 日志位置

```
%USERPROFILE%\.wechat-acp\ilink-monitor\ilink-YYYY-MM-DD.log
```

### 日志格式

```
>>> bot/sendmessage ctx=AARzJW... text=你好
<<< bot/sendmessage status=200 duration=597ms body={}
<<< bot/sendmessage status=200 duration=496ms body={"ret":-2}
```

行首标记：
- `>>>` — 请求发出
- `<<<` — 响应返回
- `===` — 模块状态变化

`sendmessage` 请求行包含截断的 `ctx`（前 200 字符）和 `text`（前 80 字符），便于追踪。

### 解读结果

| body | 含义 | 处理 |
|------|------|------|
| `{}` | 成功 | 正常 |
| `{"ret":-2}` | 限流 | 检查配额计数器，降低调用频率 |
| `{"ret":0,...}` | 成功（带其他字段） | 正常 |

## 主动测试（限流阈值探测）

### 用法

```bash
# 从桥接日志找 context_token 和 user_id
node test-iLink-rate-limit.js <context_token> <user_id>

# 固定间隔测试
node test-iLink-rate-limit.js <context_token> <user_id> --interval 500

# 递增频率（1→20次/秒，每次步进1，每级发3条）
node test-iLink-rate-limit.js <context_token> <user_id> --start-rate 1 --max-rate 5

# 仅预览请求参数，不发真实请求
node test-iLink-rate-limit.js <context_token> <user_id> --dry-run
```

### 获取 context_token

方式一：从嗅探日志中复制 `ctx=...` 参数。
方式二：从 wechat-acp 日志中找 `sendmessage` 请求体中的 `context_token`。

### 报告

测试结果自动保存到 `%USERPROFILE%\.wechat-acp\ilink-tests\ilink-test-<timestamp>.json`，包含：
- 每级速率统计（成功/限流数）
- 首次限流的调用索引和时间
- 恢复期探测结果（15s / 30s 后重试）

### 已知结论

- 限流特征：`HTTP 200` + `{"ret":-2}`，**不是 HTTP 4xx/429**
- 每 `context_token` 约 5 次 `sendmessage` 配额
- 限流后**永不恢复**，直到用户发新消息产生新 `context_token`
- `wechat-acp/api.js:63` 的 `sendMessage` 丢弃返回值，`ret=-2` 被静默吞掉

## FULL 模式配额控制（对抗方案）

`wechat-adapter.js` 中的配置：

```js
const REALTIME_FLUSH_MS = 3000;     // 流式刷出间隔
const REALTIME_MIN_FLUSH = 3500;    // 累积字符数阈值，达到后立即刷出
const FULL_QUOTA_LIMIT = 4;         // 每次回复最多 4 次 flush（预留 1 次给 end-of-turn）
```

核心逻辑：
1. `fullQuotaUsed` 计数器每次 `flushRealtime()` 或 `sendmessage` 调用时 +1
2. 满 `FULL_QUOTA_LIMIT`（4 次）后，停止所有流式 flush
3. 最终 `reply()` + `flushToWeChat()` 是第 5 次调用（end-of-turn）
4. `context_token` 在用户发新消息时自动刷新

每个模式理论 API 调用：
- **PAD（桌面 Web）**：首次通知 + 回复 = 2 次
- **PHONE（移动 Web）**：首次通知 + 回复 = 2 次
- **FULL（终端）**：配额 4 + 结束 1 = 5 次（刚好卡在限流上限）

## 限流发生时

1. `fullQuotaUsed` 满 4 后会停止 flush → 用户看不到流式输出
2. end-of-turn 的 `flushToWeChat()` 用第 5 次配额
3. 如果配额已耗尽，`ret=-2` 被 `wechat-acp` 静默丢弃，用户收不到完整回复
4. **唯一恢复方式**：用户再发一条消息，产生新 `context_token`

不能在 wechat-acp 内重试，因为同 `context_token` 下重试永远失败。

## 调试流程

### 第一步：启动带监控的桥接

```bash
restart-wechat-monitor.bat
```

### 第二步：给 bot 发消息

观察终端输出或直接查看日志：
```bash
Get-Content "$env:USERPROFILE\.wechat-acp\ilink-monitor\ilink-2026-06-16.log" -Tail 20
```

### 第三步：统计 sendmessage 次数

从日志过滤：
```
# 成功调用
Select-String "sendmessage status=200 body={}" "$env:USERPROFILE\.wechat-acp\ilink-monitor\ilink-2026-06-16.log"

# 限流调用
Select-String 'ret":-2' "$env:USERPROFILE\.wechat-acp\ilink-monitor\ilink-2026-06-16.log"
```

### 第四步：调整参数（如需）

```js
// wechat-adapter.js
const REALTIME_MIN_FLUSH = 3000;   // 降低阈值 = 更频繁刷新（实时性好但费配额）
const REALTIME_MIN_FLUSH = 4000;   // 提高阈值 = 更少刷新（省配额但延迟高）
const FULL_QUOTA_LIMIT = 3;        // 更保守，留更多余量
const FULL_QUOTA_LIMIT = 5;        // 更激进，满 6 次才彻底限流
```

### 第五步：重启测试

```bash
taskkill /f /im node.exe
# 确认 OpenCode server 是否存活，若被杀则重新启动
# 然后运行 restart-wechat-monitor.bat
```

## 日志示例解读

```
[11:21:56.688Z] >>> bot/sendmessage            ← 第1次调用（thinking通知）
[11:21:57.288Z] <<< status=200 body={}          ← 成功
[11:22:01.069Z] >>> bot/sendmessage            ← 第2次调用（文本块）
[11:22:01.412Z] <<< status=200 body={}          ← 成功
[11:22:04.981Z] >>> bot/sendmessage            ← 第3次（文本块）
...
[11:22:28.200Z] <<< status=200 body={"ret":-2}  ← 第5次被限流！
[11:22:28.203Z] >>> bot/sendmessage            ← 后续调用
[11:22:28.699Z] <<< status=200 body={"ret":-2}  ← 全部失败（永不恢复）
```

从日志可看出：前 4 次成功，第 5 次开始 `ret=-2`，之后所有调用均失败。配额上限约 5 次。

## 注意事项

1. `--import` 加载的 hook 会影响 `wechat-acp` 内部所有 fetch 调用（含 `getupdates`、`getconfig`、`sendtyping`、`sendmessage`）
2. 日志文件按天分割，长时间运行注意磁盘空间
3. `restart-wechat-monitor.bat` 中 `taskkill` 用 `wmic` 精确匹配进程名，避免误杀
4. 测试脚本发往真实用户，建议给自己的测试号发送
