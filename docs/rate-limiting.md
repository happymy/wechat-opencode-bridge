# iLink 限流触发条件与防护机制

## 背景

iLink（微信公众号/订阅号 Bot API）对每个 `context_token`（即每次用户发消息产生的会话上下文）有约 **5 次 `sendmessage` 调用配额**。超出后返回 `HTTP 200 + {"ret":-2}`，**永不自动恢复**，直到用户发新消息刷新 `context_token`。

---

## 限流触发条件

### 条件一：sendmessage 调用次数超过配额（约 5 次）

每次 `flushToWeChat()` 触发 wechat-acp 调用 `ilink/bot/sendmessage` 一次。

| 阶段 | 调用次数 | 说明 |
|------|---------|------|
| FULL 模式流式刷新 | 每次刷新 1 次 | 每次 `flushRealtime()` 调用 1 次 |
| end-of-turn flush | 1 次 | 每次回复结束时 1 次 |
| 通知推送 | 每次 1 次 | `drainPendingNotifications()` + `flushToWeChat()` |
| 思考中提示 | 1 次 | "🤔 Thinking..."、"⏳ 思考中..." 等 |

**流式刷新（FULL 模式）上限：`FULL_QUOTA_LIMIT = 4`**（`wechat-adapter.js:86`）
- 第 5 次留给 end-of-turn flush，总计刚好 5 次
- 达到上限后停止流式刷新

### 条件二：单次 sendmessage 文本超 4000 字符触发分段

wechat-acp 内部 `bridge.js` 使用 `TEXT_CHUNK_LIMIT = 4000` 拆分长文本（`node_modules/wechat-acp/dist/src/bridge.js:23,473`）：

```
回复文本 > 4000 字符 → 拆分为多段 → 每段独立调用 sendmessage
```

**每段消耗 1 次配额。** 例如 9000 字符回复拆为 3 段，消耗 3 次配额。

### 条件三：FULL 模式实时缓冲超限导致文本丢失（不触发限流，但等价于截断）

FULL 模式流式处理中，在两种情况下 delta 文本被静默丢弃：

| 丢弃点 | 条件 | 代码位置 |
|--------|------|---------|
| `realtimeBuffer` 溢出 | `fullQuotaUsed >= 4` **且** `realtimeBuffer.length >= 3000` | `wechat-adapter.js:2806-2810` |
| `pendingReplyText` 溢出 | `pendingReplyText.length >= 100000` | `wechat-adapter.js:2812-2816`（FULL）/ `:2922-2928`（PAD） |

文本被丢弃时 `pendingTruncated = true` 被设置，会话结束时用户会收到截断提示。

---

## 防护机制

### 机制一：配额计数器（FULL 模式）

```
fullQuotaUsed  →  flushRealtime() 每次 +1
               →  ≥ FULL_QUOTA_LIMIT(4) 停止流式刷新
               →  forwardToAIAsync 结束时归零
```

### 机制二：实时缓冲上限

| 常量 | 值 | 作用 |
|------|----|------|
| `MAX_REALTIME_BUFFER` | 3000 | FULL 模式实时缓冲上限，确保 end-of-turn 最多 1 段 |
| `MAX_ACCUMULATED_TEXT` | 100000 | PAD/PHONE 模式累积文本上限（continue 模式不截断） |
| `REALTIME_MIN_FLUSH` | 3500 | FULL 模式累积到该值后立即刷出 |
| `REALTIME_FLUSH_MS` | 3000 | FULL 模式流式刷出间隔（ms） |
| `MAX_REPLY_LENGTH` | 4000 | `reply()` 单次发送的最大字符数 |

### 机制三：超长回复策略（`/quota` 别名 `t`/`trunc`, `n`/`notif`, `c`/`cont`）

三种模式，全局生效，通过 `.wechat-filter.json` 持久化：

```
truncate (t/trunc)  → 静默截断，直接丢弃超限部分，不通知
notify   (n/notif)  → 截断并发通知："回复已截断，超出上限"
continue (c/cont)   → 保存超限文本到 FIFO 消息队列，用户发 /g 逐条取出
```

会话结束时若发生过截断，发送提示：`⚠️ 回复过长已截断，完整内容请在 OpenCode 界面查看`

#### continue 模式消息队列（`/g` `/x`）

启用 `continue` 策略后，超限文本按 4000 字符预分割为多条消息存入 FIFO 队列：

| 命令 | 别名 | 说明 |
|------|------|------|
| `/g` | `/get` `/cont` | 取出下一条并发送，显示进度 `done/total` + 剩余条数；最后一条显示 `✅ 续发完毕（共 N 条）` |
| `/x` | `/gc` | 清除所有待续发内容 |

队列为空时 `/g` 返回 `📭 没有待续发的内容`。
队列仅保存当前最后一次超限的内容，新超限发生时会覆盖旧队列。

### 机制四：FULL 模式流式刷新策略

```
flushRealtime():
  1. realtimeBuffer 为空              → 不操作
  2. lastPromptSid 为空               → 不操作
  3. fullQuotaUsed >= FULL_QUOTA_LIMIT → 不操作（配额耗尽）
  4. 条件满足                          → reply() + flushToWeChat()，fullQuotaUsed++
```

触发即时刷新的条件（任意一个满足即可）：
- `realtimeBuffer.length >= REALTIME_MIN_FLUSH(3500)`
- `realtimeBuffer.length > 500` 且 delta 含句末标点（`\n。！？.!?`）

未满足即时条件时，由定时器 `REALTIME_FLUSH_MS(3000ms)` 触发。

---

## 各模式配额消耗参考

### PAD / PHONE 模式

| 阶段 | sendmessage 调用 | 说明 |
|------|-----------------|------|
| 思考中通知 | 可选 | 首条通知 |
| 回复文本 | 1 次（≤4000 字符） | `reply()` → `flushToWeChat()` |
| 回复文本 | N 次（>4000 字符） | wechat-acp 按 4000 分段 |
| 通知 | 与回复合并 | `drainPendingNotifications()` + 回复 flush |
| **总计** | **2 ~ 4 次** | 正常范围 |

### FULL 模式

| 阶段 | sendmessage 调用 | 说明 |
|------|-----------------|------|
| "🤔 Thinking..." | 1 次 | 推理开始时 |
| "✅ Thinking complete" | 1 次 | 推理完成时 |
| 流式文本块 | ≤ 4 次 | `REALTIME_MIN_FLUSH` / `REALTIME_FLUSH_MS` 触发 |
| end-of-turn flush | 1 次 | `session.idle` 触发 |
| 工具调用通知 | 每次 1 次 | 每个工具开始/完成 |
| **总计** | **5 次以内** | 刚好卡在配额上限 |

---

## 限流发生时的表现

1. wechat-acp 日志：`<<< bot/sendmessage status=200 body={"ret":-2}`
2. 消息静默丢失，用户看不到后续内容
3. **唯一恢复方式**：用户再发一条消息，产生新 `context_token`
4. 同 `context_token` 下重试永远失败

---

## 调试方法

```bash
# 启动带监控的桥接
restart-wechat-monitor.bat

# 查看限流日志
Select-String "sendmessage status=200 body={}" "$env:USERPROFILE\.wechat-acp\ilink-monitor\ilink-$(Get-Date -Format yyyy-MM-dd).log"
Select-String 'ret":-2' "$env:USERPROFILE\.wechat-acp\ilink-monitor\ilink-$(Get-Date -Format yyyy-MM-dd).log"

# 主动测试限流阈值
node test-iLink-rate-limit.js <context_token> <user_id>
```
