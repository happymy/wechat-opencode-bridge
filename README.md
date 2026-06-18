# WeChat Opencode Bridge

通过微信远程操控 [OpenCode](https://opencode.ai) CLI 的 ACP Agent 适配器。

本仓库源自 [`happymy/opencode-quickstart-workspace`](https://github.com/happymy/opencode-quickstart-workspace/tree/master)（MIT 许可证），作为独立项目维护，定期同步上游更新。

---

## Fork 说明

### 来源
本仓库由 [opencode-quickstart-workspace](https://github.com/happymy/opencode-quickstart-workspace/tree/master) 独立出来，专注于 WeChat ↔ OpenCode 桥接功能，移除了与 Web UI 和 mock 相关的文件。

### 同步策略
从上游同步时，根据文件类型采用不同策略：

| 策略 | 文件 | 操作 |
|------|------|------|
| **🔴 手动合并** | `wechat-adapter.js` | 上游可能有改进，需逐行 merge |
| **🟡 选择性更新** | `wechat-bridge.bat` `restart-wechat.bat` `.tool-versions.json` | 差异较小时可直接覆盖 |
| **🟢 直接覆盖** | `docs/*` `LICENSE` `README.md` | 上游更新可安全覆盖后重新适配 |
| **⚪ 忽略** | `.gitattributes` `plan/` | 仅本仓库存在，不受同步影响 |
| **⚪ 可选引入** | `del.py` `run_del_nul.bat` `setup.bat` `start-all.bat` `stop-all.bat` `web.bat` `package.json` `package-lock.json` `ilink-monitor-hook.js` `restart-wechat-monitor.bat` `test-iLink-rate-limit.js` | 上游有但我们未使用的文件，按需引入 |

### 同步步骤
```bash
# 添加上游 remote
git remote add upstream https://github.com/happymy/opencode-quickstart-workspace.git

# 拉取上游
git fetch upstream

# 按上述策略选择性合并文件
git checkout upstream/master -- wechat-bridge.bat restart-wechat.bat
# 对 wechat-adapter.js 执行手动 merge
```

---

## 架构

```
微信客户端 → wechat-acp (stdio) → wechat-adapter.js (ACP Agent)
                                       ↓ HTTP API
                                  OpenCode Server (:4096)
                                       ↓ SSE/Event
                                  主动通知 → 微信
```

- **wechat-acp**：通过标准输入/输出与 wechat-adapter.js 通信，转发微信消息和推送通知
- **wechat-adapter.js**：ACP Agent 实现，将微信消息转为 OpenCode HTTP API 调用，同时订阅 SSE 事件推送通知
- **OpenCode Server**：AI 会话引擎，提供 HTTP API 和 SSE 事件流

---

## 功能

- 微信中发送消息给 OpenCode AI 会话，接收回复
- 三级信息过滤：FULL（实时流式） / PAD（折叠摘要） / PHONE（极简）
- 会话管理：列表、切换、新建
- 模式切换：plan / build
- 问题回答与权限审批（通知中直接回复）
- 主动通知：SSE 事件推送到微信（完成、错误、等待、卡死等）
- 多个 OpenCode 工作区管理
- 工作区目录自动发现与同步

---

## 快速开始

```bash
# 安装 wechat-acp
npm install -g wechat-acp

# 启动微信机器人（首次需扫码登录）
wechat-bridge.bat
```

环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCODE_SERVER` | `http://localhost:4096` | OpenCode 服务器地址 |
| `OPENCODE_AUTH` | `opencode:opencode` | Basic Auth 凭证 |

> ⚠️ **首次使用必须先向机器人发一条消息（如 `/help`）**，之后才能收到主动通知。

---

## 命令列表

### 会话管理

| 命令 | 别名 | 说明 |
|------|------|------|
| `/list` | `/l` `/ls` `/sessions` | 查看当前工作区会话列表 |
| `/switch` | `/s` `/sw` | 切换会话 |
| `/new` | `/nl` `/create` | 新建会话 |
| `/cancel` | `/c` | 取消当前任务 |

### 模式切换

| 命令 | 别名 | 说明 |
|------|------|------|
| `/plan` | `/pl` | plan 模式 |
| `/build` | `/bu` | build 模式 |

### 信息过滤

| 命令 | 别名 | 说明 |
|------|------|------|
| `/level [f\|p\|ph]` | `/lvl` | 查看/设置过滤级别 |
| `/f` | — | FULL 模式（实时流式传输） |
| `/pd` | — | PAD 模式（折叠摘要，默认） |
| `/ph` | — | PHONE 模式（极简，仅文字） |

### 三级信息过滤渲染差异

| 消息类型 | FULL（实时流式） | PAD（折叠摘要） | PHONE（极简） |
|---------|----------------|---------------|-------------|
| **文本** | 实时流式发送，每 400ms 刷出 | 累积后一次性发送 | 累积后一次性发送 |
| **思考/推理** | 实时流式显示 `🤔 Thinking...` → 内容 → `✅ Thinking complete (Xs)` | 折叠为 `+ Thinking: X.Xs` | 完全隐藏 |
| **工具调用** | 实时显示 `🔧 tool_name [input]` → `✅ tool_name` | 折叠为 `⚙tool_name [input]` | 完全隐藏 |
| **工具错误** | 实时显示 `❌ tool_name: error` | 显示 `❌ tool_name: error` | 完全隐藏 |
| **shell/MCP** | 等同工具调用，实时流式 | 等同工具调用，折叠 | 完全隐藏 |

### 问题与权限

| 命令 | 别名 | 说明 |
|------|------|------|
| `/answer [编号] <内容>` | `/ans` | 回答 AI 提问 |
| `/skip [编号]` | `/pass` `/ps` | 跳过问题 |
| `/qlist` | `/ql` `/questions` | 待回答问题列表 |
| `/allow [编号\|ID]` | `/a` | 批准权限 |
| `/deny [编号\|ID]` | `/d` | 拒绝权限 |
| `/trust [编号\|ID]` | `/t` | 信任权限 |
| `/plist` | `/p` `/pending` | 待审批权限列表 |

### 工作区与系统

| 命令 | 别名 | 说明 |
|------|------|------|
| `/workspace [add\|del]` | `/ws` | 工作区管理 |
| `/sd` | — | 从 DB 同步工作区 |
| `/status` | `/st` | 任务运行状态 |
| `/mute` | `/m` | 开关主动通知 |
| `/notify` | `/n` | 通知与订阅信息 |
| `/help` | `/h` | 帮助信息 |

---

## 主动通知

SSE 事件实时推送至微信：

| 事件 | 格式 | 说明 |
|------|------|------|
| 会话完成 | `✅ 完成` | 任务执行完毕 |
| 会话出错 | `❌ 错误类型` + 详情 | 执行错误 |
| 需要回答 | `💬 需要回答` + 问题 | AI 等待输入 |
| 需要权限 | `#N 操作` + 路径 | 文件/命令权限请求 |
| 疑似卡死 | `🔴 卡死「名称」X分钟无响应` | 10 分钟无响应 |
| 可能卡住 | `⏰ 可能卡住「名称」X分钟无活动` | 5 分钟无活动 |
| 重试循环 | `🔄 重试循环N次` | 连续重试 |

---

## 状态文件

运行时自动生成，不纳入版本控制：

| 文件 | 说明 |
|------|------|
| `.wechat-session.json` | 当前会话 ID |
| `.wechat-subscribers.json` | 订阅者列表 |
| `.wechat-workspaces.json` | 工作区预设 |
| `.wechat-workspace-current.json` | 当前工作区 |
| `.wechat-settings.json` | 全局设置 |
| `.wechat-filter.json` | 过滤级别持久化 |
| `.wechat-adapter.log` | 运行时日志 |

---

## 协议

遵循 [ACP (Agent Communication Protocol)](https://github.com/agentcommunicationprotocol/acp) 规范，使用 JSON-RPC 2.0 over stdio。

## 许可证

MIT
