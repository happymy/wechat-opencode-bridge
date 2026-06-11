# 开箱即用 — OpenCode 开发工作区

OpenCode + wechat-acp + WeChat 机器人集成工作区。

## 结构

```
work/
├── pk-opencode-webui/       # 第三方 OpenCode Web UI（独立 git 仓库）
├── wechat-adapter.js        # WeChat 机器人适配器（ACP Agent，~1900 行）
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

## 微信机器人命令

在微信中发送命令给机器人，支持以下命令（`名称` 和 `别名` 均可使用）：

| 命令 | 别名 | 说明 |
|------|------|------|
| `/list` | `/l` `/sessions` | 查看 OpenCode 会话列表 |
| `/switch <编号\|ID>` | `/s` | 切换当前会话 |
| `/new <会话名>` | `/create` | 新建会话（当前工作区）并自动切换 |
| `/plan` | `/pl` | 切换到 plan 模式 |
| `/build` | `/bu` | 切换到 build 模式（默认） |
| `/workspace` | `/ws` | 查看/切换工作区 |
| `/sd` | — | 从 OpenCode 会话同步工作区列表 |
| `/status` | `/st` | 查看任务运行状态 |
| `/cancel` | `/c` | 取消当前 AI 执行 |
| `/allow [编号\|ID]` | `/a` | 批准权限请求 |
| `/deny [编号\|ID]` | `/d` | 拒绝权限请求 |
| `/trust [编号\|ID]` | `/t` | 信任权限（不再询问） |
| `/plist` | `/p` `/pending` | 查看待审批权限列表 |
| `/mute` | `/m` | 开关通知（默认开启） |
| `/notify` | `/n` | 查看通知设置状态 |
| `/autoclean [天数]` | `/ac` | 查看/设置不活跃订阅清理阈值 |
| `/answer [问题编号] <内容>` | `/ans` | 回答AI提问。可用 [问题编号] 指定，为空则默认第1题 |
| `/skip [编号]` | `/pass` `/ps` | 跳过指定问题（默认当前） |
| `/qlist` | `/ql` `/questions` | 查看所有待回答问题 |
| `/qshow` | `/qc` `/qcurrent` | 显示当前问题的完整内容 |
| `/qselect <编号>` | `/qs` `/qsel` | 选中指定问题为当前活跃 |
| `/testnotify` | — | 发送测试通知（调试用） |
| `/help` | `/h` | 显示帮助信息 |

非命令消息将转发给当前选中的 OpenCode 会话，由 AI 处理。

通过 `/allow`、`/deny`、`/trust` 命令，可直接在微信中审批权限请求，无需再打开 Web UI。
`/plist` 会自动同步服务器状态，清除已过期或已通过其他端处理的请求。

## 主动通知

机器人通过 SSE 监听 OpenCode 事件，实时推送通知到微信：

| 事件 | 通知内容 | 说明 |
|------|----------|------|
| 会话完成 | ✅ 完成 | 任务执行完毕 |
| 会话出错 | ❌ 会话出错 | 执行中发生错误 |
| 需要回答 | 💬 需要你回答 | AI 在等待用户输入，可直接回复答案；多题模式编号选择 |
| 需要权限 | 📋 待审批权限 | AI 请求文件/命令执行权限，推送格式：`#N [会话名] 操作\n路径` |
| 卡死检测 | 🔴 卡死 / ⏰ 可能卡住 | 5 分钟无活动警告，10 分钟卡死 |
| 重试循环 | 🔄 AI重试循环 | 连续 3 次重试未恢复 |

通知同时发送给所有已订阅的微信用户（非静音状态）。
通知通过 `agent_message_chunk` 累积，并在 `tool_call` 触发时通过 `maybeFlushMessage()` 发送到微信。
权限审批通知末尾附带了操作提示（`/allow (/a) 批准 | /deny (/d) 拒绝 | /trust (/t) 信任 | +<编号>`），可直接在微信中操作。
问题通知末尾附带了 `/ans (/answer)`、`/skip (/pass, /ps)`、`/qlist (/ql, /questions)`、`/qshow (/qc, /qcurrent)`、`/qselect (/qs, /qsel)` 等操作提示，多个 `question.asked` 事件自动排队，依次处理。

## 状态文件

运行时自动生成，均已加入 `.gitignore`：

| 文件 | 说明 |
|------|------|
| `.wechat-session.json` | 当前选中的 OpenCode 会话 ID |
| `.wechat-subscribers.json` | 微信用户订阅列表 |
| `.wechat-workspaces.json` | 工作区预设（名称 + 路径） |
| `.wechat-workspace-current.json` | 当前工作区路径 |
| `.wechat-settings.json` | 全局设置（如不活跃清理阈值） |
| `.wechat-adapter.log` | 运行时日志 |
