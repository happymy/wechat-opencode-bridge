# 开箱即用 — OpenCode 开发工作区

OpenCode + wechat-acp + WeChat 机器人集成工作区。

## 结构

```
work/
├── pk-opencode-webui/       # 第三方 OpenCode Web UI（独立 git 仓库）
├── wechat-adapter.js        # WeChat 机器人适配器（ACP Agent，~2100 行）
├── start-all.bat            # 一键启动所有服务
├── stop-all.bat             # 停止所有服务
├── web.bat                  # 启动 OpenCode Web UI
├── restart-wechat.bat       # 重启微信机器人（修改 wechat-adapter.js 后使用）
├── wechat-bridge.bat        # 启动 wechat-acp 守护进程
├── setup.bat                # 环境安装与修复脚本
├── run.bat                  # 运行任务
├── del.py                   # 临时清理工具
├── dev.db                   # OpenCode 开发数据库
├── sqlite_mcp_server.db     # SQLite MCP 数据库
├── .wechat-session.json     # 当前选中的 OpenCode 会话 ID
├── .wechat-subscribers.json # 微信订阅者列表（含静音状态）
├── .wechat-workspaces.json  # 工作区预设列表
├── .wechat-workspace-current.json # 当前选中的工作区
├── .wechat-adapter.log      # 运行时日志（自动轮转，上限 1MB）
├── package.json             # Node.js 依赖
├── README.md
└── .gitignore
```

## 服务

| 服务 | 端口 | 说明 |
|------|------|------|
| OpenCode Web | 4096 | 官方 Web UI，需 Basic Auth |
| pk-opencode-webui | 2048 | 第三方 Web UI |
| WeChat bot | — | 微信机器人，共享会话 |

## 环境安装

首次使用或遇到依赖问题时，运行：

```bash
setup.bat
```

脚本会自动检查/安装：Node.js、Bun、opencode CLI、npm 依赖，自动 clone 并安装 pk-opencode-webui，刷新 wechat-acp（清除 npx 缓存后重新下载）。

## 启动

```bash
start-all.bat
```

或单独启动：

```bash
web.bat            # OpenCode Web UI + pk-opencode-webui
wechat-bridge.bat  # WeChat 机器人
```

## Web UI

系统包含两个 Web 界面，共享同一份会话数据：

### 官方 Web UI（端口 4096）

- 地址：http://localhost:4096
- 登录：用户名 `opencode`，密码 `opencode`
- 功能：会话管理、AI 对话、**权限审批**、文件查看等

### 第三方 Web UI（端口 2048）

- 地址：http://localhost:2048
- 免登录，自动连接 4096 后端
- 提供不同的界面风格

### 权限审批

AI 请求文件操作或命令执行时，微信会收到通知。可以直接在微信中审批，无需打开 Web UI：

- `/allow` (`/a`) — 批准权限请求（允许一次）
- `/deny` (`/d`) — 拒绝权限请求
- `/trust` (`/t`) — 信任权限（始终允许，不再询问）
- `/plist` (`/p`, `/pending`) — 查看待审批权限列表

命令后跟可选的编号或 requestID。
不指定参数时默认为 `#1`（最新请求）。
`/plist`（`/p`, `/pending`）会自动同步服务器状态，清理已过期或已处理的请求。

也可以通过 Web UI 审批：http://localhost:4096 → 进入会话 → 权限弹窗。

## 环境变量（可选）

`wechat-adapter.js` 支持环境变量覆盖默认配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCODE_SERVER` | `http://localhost:4096` | OpenCode 服务器地址 |
| `OPENCODE_AUTH` | `opencode:opencode` | Basic Auth 用户名:密码 |

> ⚠️ **重要提示：首次使用，必须先向微信机器人发送一条消息（如 `/help`），之后才能收到主动通知。**  
> wechat-acp 驱动的机器人仅在收到微信消息后的窗口内才能推送事件。不先发一条消息，机器人无法主动联系你。

### 响应格式

AI 响应以 `🤖\n` 为前缀发送文本内容。根据当前过滤级别不同，展示内容不同：
- **FULL**：实时流式输出，包含推理过程、工具调用和文件差异。⚠️ 高频推送触发微信 iLink 限流时，回复后半段可能丢失，**不推荐日常使用**
- **PAD**（默认，推荐）：累积文本后一次性发送，等待中显示处理提示，仅发送 AI 文本回复，无丢消息风险
- **PHONE**：极简模式，仅显示 AI 文本回复和错误

超长消息（超过 2000 字符）自动分段发送。

## 微信机器人命令

在微信中发送命令给机器人，支持以下命令。通知消息中可直接回复答案或审批，无需输入命令前缀。

### 会话管理

| 命令 | 别名 | 说明 |
|------|------|------|
| `/list` | `/l` `/ls` `/sessions` | 查看当前工作区会话列表；`/l all [+数字]` 查看全部会话前N条 |
| `/switch <编号\|ID>` | `/s` `/sw` | 切换会话 |
| `/new <会话名>` | `/nl` `/create` | 在当前工作区新建会话并自动切换 |

### 模式切换

| 命令 | 别名 | 说明 |
|------|------|------|
| `/plan` | `/pl` | 切换到 plan 模式（规划方案） |
| `/build` | `/bu` | 切换到 build 模式（执行代码，默认） |

### 信息过滤

控制 AI 响应在微信中的展示粒度：

| 命令 | 别名 | 说明 |
|------|------|------|
| `/level [级别]` | `/lvl` | 查看或设置过滤级别 |
| `/f` | — | FULL 模式：实时流式输出，显示所有信息 ⚠️ 限流风险 |
| `/pd` | — | PAD 模式：累积文本后一次性发送，仅 AI 文本回复（**默认，推荐**） |
| `/ph` | — | PHONE 模式：极简模式，仅显示 AI 文本回复和错误 |

> ⚠️ **FULL 模式（/f）不推荐日常使用。** 该模式通过微信实时推送每个文本/工具增量，每次推送消耗一次 wechat-acp API 调用。长文本生成时（10k+ 字符）API 调用可达十余次，易触发微信 iLink 接口限流。**限流后后续消息全部静默丢失**，用户只看到前半段回复，无法感知不完整。除非明确需要实时查看 AI 推理过程，否则建议使用 PAD 模式（默认），或通过 OpenCode Web UI (http://localhost:4096) 查看完整输出。

### 问题回答

AI 暂停等待输入时，微信会收到通知。可直接回复内容，或用以下命令：

| 命令 | 别名 | 说明 |
|------|------|------|
| `/answer [编号] <内容>` | `/ans` | 回答指定编号的问题（默认第1题） |
| `/skip [编号]` | `/pass` `/ps` | 跳过指定问题（默认当前） |
| `/qlist` | `/ql` `/questions` | 查看所有待回答问题 |
| `/qshow` | `/qc` `/qcurrent` | 显示当前问题的完整内容 |
| `/qselect <编号>` | `/qs` `/qsel` | 选中指定问题为当前活跃 |

### 权限审批

AI 请求文件操作或命令执行时，微信会收到通知。可直接在微信中审批：

| 命令 | 别名 | 说明 |
|------|------|------|
| `/allow [编号\|ID]` | `/a` | 批准权限请求（默认最新） |
| `/deny [编号\|ID]` | `/d` | 拒绝权限请求 |
| `/trust [编号\|ID]` | `/t` | 信任权限（不再询问） |
| `/plist` | `/p` `/pending` | 查看待审批权限列表（自动同步服务器状态） |

### 工作区与任务

| 命令 | 别名 | 说明 |
|------|------|------|
| `/workspace [add\|del]` | `/ws` | 查看/切换/添加/删除工作区 |
| `/sd` | — | 从 OpenCode 数据库同步所有项目工作区 |
| `/status` | `/st` | 查看任务运行状态 |
| `/cancel` | `/c` | 取消当前 AI 执行 |

### 通知与系统

| 命令 | 别名 | 说明 |
|------|------|------|
| `/mute` | `/m` | 开关主动通知（默认开启） |
| `/notify` | `/n` | 查看通知设置与订阅状态 |
| `/autoclean [天数]` | `/ac` | 查看/设置不活跃订阅自动清理天数 |
| `/testnotify` | — | 发送测试通知（调试用） |
| `/help` | `/h` | 显示帮助信息 |

> 💡 通知消息中可直接回复答案或权限审批，无需输入命令前缀。
> 💡 未识别的消息将转发给当前选中的 AI 会话。

## 主动通知

机器人通过 SSE 监听 OpenCode 事件，实时推送通知到微信：

| 事件 | 通知格式示例 | 说明 |
|------|-------------|------|
| 会话完成 | `✅ MyProject · 完成` | 任务执行完毕 |
| 会话出错 | `❌ 错误类型` + `错误详情` | 执行中发生错误 |
| 需要回答 | `[Session] 💬 需要你回答` + 问题内容 + 操作提示 | AI 在等待用户输入，多条自动排队依次处理 |
| 需要权限 | `#1 [Session] 操作` + `\n路径` + 操作提示 | AI 请求文件/命令执行权限，多条分别审批 |
| 会话跟随 | `🔄 已跟随到会话「名称」` | TUI 切换到其他会话时自动跟随 |
| 新会话创建 | `🆕 新会话已创建，已自动跟随` | 当前工作区下新建会话时自动跟随 |
| 疑似卡死 | `🔴 卡死\n「名称」已运行X分钟无响应` | 10 分钟无响应（硬超时预警） |
| 可能卡住 | `⏰ 可能卡住\n「名称」已X分钟无活动` | 5 分钟无活动（软超时提醒） |
| 重试循环 | `🔄 AI重试循环\n已连续重试N次，请检查` | 连续 3 次重试未恢复 |

> 通知同时发送给所有已订阅的微信用户（非静音状态）。
> 通知通过 wechat-acp 的 `agent_message_chunk` 累积，批量合并后发送到微信。

**权限通知操作提示：** `#N` 行后自动附加 `/allow (/a) 批准 | /deny (/d) 拒绝 | /trust (/t) 信任 | +<编号>`
**问题通知操作提示：** 末尾自动附加 `/ans (/answer) <内容> 提交`、`/skip (/pass, /ps)`、`/qlist (/ql, /questions)` 等操作提示

`question.asked` 事件支持自动排队。如果当前正有未回答的问题，新到达的问题会进入队列，当前问题处理完毕后自动推送下一题。超过 5 分钟未处理的问题自动过期。可通过 `/qlist`、`/qshow`、`/qselect` 管理多题。

在收到问题通知或权限通知时，**可以直接在微信中回复**（输入答案或审批命令），无需手动输入 `/answer` 或 `/allow` 前缀——但需要记住对应命令格式（如通知末尾的提示）。

## 状态文件

运行时自动生成，均已加入 `.gitignore`：

| 文件 | 说明 |
|------|------|
| `.wechat-session.json` | 当前选中的 OpenCode 会话 ID |
| `.wechat-subscribers.json` | 微信用户订阅列表 |
| `.wechat-workspaces.json` | 工作区预设（名称 + 路径） |
| `.wechat-workspace-current.json` | 当前工作区路径 |
| `.wechat-settings.json` | 全局设置（如不活跃清理阈值） |
| `.wechat-filter.json` | 信息过滤级别持久化存储（full/pad/phone） |
| `.wechat-adapter.log` | 运行时日志 |
