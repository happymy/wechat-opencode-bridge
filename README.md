# work — OpenCode 开发工作区

OpenCode + wechat-acp + WeChat 机器人集成工作区。

## 结构

```
work/
├── pk-opencode-webui/       # 第三方 OpenCode Web UI（独立 git 仓库）
├── wechat-adapter.js        # WeChat 机器人适配器（ACP Agent，~1000 行）
├── start-all.bat            # 一键启动所有服务
├── stop-all.bat             # 停止所有服务
├── web.bat                  # 启动 OpenCode Web UI
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

脚本会自动检查/安装：Node.js、Bun、opencode CLI、npm 依赖、pk-opencode-webui 依赖，并刷新 wechat-acp（清除 npx 缓存后重新下载）。

## 启动

```bash
start-all.bat
```

或单独启动：

```bash
web.bat            # OpenCode Web UI + pk-opencode-webui
wechat-bridge.bat  # WeChat 机器人
```

## 环境变量（可选）

`wechat-adapter.js` 支持环境变量覆盖默认配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCODE_SERVER` | `http://localhost:4096` | OpenCode 服务器地址 |
| `OPENCODE_AUTH` | `opencode:opencode` | Basic Auth 用户名:密码 |

## 微信机器人命令

在微信中发送命令给机器人，支持以下命令（`名称` 和 `别名` 均可使用）：

| 命令 | 别名 | 说明 |
|------|------|------|
| `/list` | `/l` `/sessions` | 查看 OpenCode 会话列表 |
| `/switch <编号\|ID>` | `/s` | 切换当前会话 |
| `/new <会话名>` | `/create` | 新建会话（当前工作区）并自动切换 |
| `/plan` | `/pl` | 切换当前会话为 plan 模式 |
| `/build` | `/bu` | 切换当前会话为 build 模式（默认） |
| `/workspace` | `/ws` | 查看/切换工作区 |
| `/status` | `/st` | 查看任务运行状态 |
| `/cancel` | `/c` | 取消当前 AI 执行 |
| `/mute` | `/m` | 开关通知（默认开启） |
| `/notify` | `/n` | 查看通知设置状态 |
| `/plist` | `/pending` | 查看待审批权限列表 |
| `/testnotify` | — | 发送测试通知（调试用） |
| `/help` | `/h` | 显示帮助信息 |

非命令消息将转发给当前选中的 OpenCode 会话，由 AI 处理。

> 权限审批已移至 Web UI（http://localhost:4096），微信中不再支持 `/allow`、`/deny`、`/trust` 命令。`/plist` 仍可查看待审批列表。

## 主动通知

机器人通过 SSE 监听 OpenCode 事件，实时推送通知到微信：

| 事件 | 通知内容 | 说明 |
|------|----------|------|
| 会话完成 | ✅ 完成 | 任务执行完毕 |
| 会话出错 | ❌ 会话出错 | 执行中发生错误 |
| 需要回答 | 💬 需要你回答 | AI 在等待用户输入 |
| 需要权限 | 🔑 需要权限 | AI 请求文件/命令执行权限（需 Web UI 审批） |
| 卡死检测 | 🔴 卡死 / ⏰ 可能卡住 | 5 分钟无活动警告，10 分钟卡死 |
| 重试循环 | 🔄 AI重试循环 | 连续 3 次重试未恢复 |

通知同时发送给所有已订阅的微信用户（非静音状态）。
通知通过 `agent_message_chunk` 累积，并在 `tool_call` 触发时通过 `maybeFlushMessage()` 发送到微信。

## 状态文件

运行时自动生成，均已加入 `.gitignore`：

| 文件 | 说明 |
|------|------|
| `.wechat-session.json` | 当前选中的 OpenCode 会话 ID |
| `.wechat-subscribers.json` | 微信用户订阅列表 |
| `.wechat-workspaces.json` | 工作区预设（名称 + 路径） |
| `.wechat-workspace-current.json` | 当前工作区路径 |
| `.wechat-adapter.log` | 运行时日志，超出 1MB 自动清空 |
