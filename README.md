# 开箱即用 — OpenCode 开发工作区

OpenCode + wechat-acp + WeChat 机器人集成工作区。

## 结构

```
work/
├── pk-opencode-webui/       # 第三方 OpenCode Web UI（独立 git 仓库，版本锁定）
├── src/
│   └── utils.js             # 纯函数工具库（测试入口）
├── wechat-adapter.js        # WeChat 机器人适配器（ACP Agent）
├── start-all.bat            # 一键启动所有服务
├── stop-all.bat             # 停止所有服务
├── web.bat                  # 启动 OpenCode Web UI
├── restart-wechat.bat       # 重启微信机器人（修改 wechat-adapter.js 后使用）
├── wechat-bridge.bat        # 启动 wechat-acp 守护进程
├── setup.bat                # 环境安装与版本锁定脚本
├── run_del_nul.bat          # 运行任务（删除 nul 文件后执行）
├── del.py                   # 删除当前目录下的 nul 文件
├── .tool-versions.json      # 版本锁定文件（所有工具/仓库的锁定版本）
├── .wechat-session.json     # 当前选中的 OpenCode 会话 ID
├── .wechat-subscribers.json # 微信订阅者列表（含静音状态）
├── .wechat-workspaces.json  # 工作区预设列表
├── .wechat-workspace-current.json # 当前选中的工作区
├── .wechat-adapter.log      # 运行时日志（超 200MB 自动截断至 100MB）
├── package.json             # Node.js 依赖
├── vitest.config.js         # Vitest 测试配置
├── tests/
│   ├── setup.js             # 全局 mock 配置
│   ├── unit/utils/
│   │   ├── helpers.test.js           # 核心纯函数测试（17 函数）
│   │   ├── edge-cases.test.js        # null/undefined/边界值测试
│   │   ├── question.test.js          # formatQuestionBody 测试
│   │   └── notification.test.js      # 通知消息格式测试
│   ├── unit/command/                  # 预留：命令处理单元测试
│   └── integration/
│       └── event-format.test.js      # eventToNotification 集成测试
└── README.md
```

## 服务

| 服务 | 端口 | 说明 |
|------|------|------|
| OpenCode Web | 4096 | 官方 Web UI，需 Basic Auth |
| pk-opencode-webui | 2048 | 第三方 Web UI |
| WeChat bot | — | 微信机器人，共享会话 |

## 版本锁定

所有工具和依赖的版本由 `.tool-versions.json` 统一管理：

| 类别 | 锁定项 | 说明 |
|------|--------|------|
| 运行时 | Node.js、npm、Bun | 安装后比对版本，不匹配输出 `[WARN]` |
| Shell | PowerShell 7+ | 同上 |
| 语言 | Python | 同上 |
| VCS | Git | 同上 |
| npm 包 | opencode CLI | 未安装时装锁定版本，已安装版本不匹配则 warn |
| npx 包 | wechat-acp | 始终下载锁定版本（`npx wechat-acp@<版本>`） |
| Git 仓库 | pk-opencode-webui | 克隆后 checkout 锁定 commit，已存在时校验 HEAD |

## 环境安装

首次使用或遇到依赖问题时，运行：

```bash
setup.bat
```

脚本自动读取 `.tool-versions.json` 中的版本锁，检查/安装：Node.js、Bun、opencode CLI（锁定版本）、npm 依赖，自动 clone 并锁定 pk-opencode-webui 至指定 commit，刷新 wechat-acp（锁定版本）。

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
- **FULL**：实时流式输出，包含推理过程、工具调用和文件差异。触发 iLink 限流时自动截断并通知用户，**日常使用注意配额消耗**
- **PAD**（默认，推荐）：累积文本后一次性发送，等待中显示处理提示，仅发送 AI 文本回复，无丢消息风险
- **PHONE**：极简模式，仅显示 AI 文本回复和错误

iLink API 对每个 `context_token` 有约 5 次 `sendmessage` 配额，超过后回复会被截断。可通过 `/quota` 命令设置超长回复策略。详见 [限流触发条件与防护机制](docs/rate-limiting.md)。

## 微信机器人命令

在微信中发送命令给机器人，支持以下命令。通知消息中可直接回复答案或审批，无需输入命令前缀。

### 会话管理

| 命令 | 别名 | 说明 |
|------|------|------|
| `/list` | `/l` `/ls` `/sessions` | 查看当前工作区会话列表；`/l all [+数字]` 查看全部会话前N条 |
| `/switch <编号\|ID>` | `/s` `/sw` | 切换会话 |
| `/new <会话名>` | `/nl` `/create` | 在当前工作区新建会话并自动切换 |
| `/compact` | `/summarize` | 压缩当前会话，节省上下文 tokens |

### 模式切换

| 命令 | 别名 | 说明 |
|------|------|------|
| `/plan` | `/pl` | 切换到 plan 模式（规划方案） |
| `/build` | `/bu` | 切换到 build 模式（执行代码，默认） |

### 模型管理

| 命令 | 别名 | 说明 |
|------|------|------|
| `/models` | — | 列出所有可用模型（按 provider 分组） |
| `/switchmodel <provider/model>` | `/sm` | 切换当前会话模型，下次消息使用；不加参数查看当前模型 |
| `/rmmodel` | — | 清除模型覆盖，恢复会话默认模型 |

### 撤销与恢复

| 命令 | 别名 | 说明 |
|------|------|------|
| `/undo` | — | 撤销上一条消息及其所有文件改动（需要 Git 仓库） |
| `/redo` | — | 恢复已撤销的消息 |

### 信息过滤与超长回复

控制 AI 响应在微信中的展示粒度：

| 命令 | 别名 | 说明 |
|------|------|------|
| `/level [f|p|ph]` | `/lvl` | 查看或设置过滤级别，别名 f/full, p/pad, ph/phone |
| `/f` | — | FULL 模式：实时流式输出，显示所有信息 ⚠️ 限流风险 |
| `/pd` | — | PAD 模式：累积文本后一次性发送，仅 AI 文本回复（**默认，推荐**） |
| `/ph` | — | PHONE 模式：极简模式，仅显示 AI 文本回复和错误 |
| `/thinking` | — | 切换思维推理过程显示/隐藏（不影响处理提示） |
| `/quota [t|n|c]` | `/q` | 查看/设置超长回复策略 (t:截断 n:通知 c:续传)；continue 模式下发 `/g` 续发 |
| `/continue` | `/g` `/get` `/cont` | 续发模式：从消息队列取出下一条（显示进度 `done/total`） |
| `/clear-continue` | `/x` `/gc` | 清除待续发内容 |

> ⚠️ **FULL 模式（/f）注意配额消耗。** 每次 `flushToWeChat()` 消耗一次 iLink `sendmessage` 调用，每个 `context_token` 约 5 次上限。流式刷新上限 `FULL_QUOTA_LIMIT=4`，预留 1 次给结束 flush。超限时自动截断并发送通知，完整内容请在 OpenCode Web UI (http://localhost:4096) 查看。
>
> **超长回复策略（`/quota`）：** 影响所有模式。别名：`t`/`trunc`, `n`/`notif`, `c`/`cont`。
> - `truncate`（默认）— 静默截断，超限部分直接丢弃
> - `notify` — 截断并发通知："回复已截断，超出上限"
> - `continue` — 保存超限文本到 FIFO 消息队列（每段 ≤4000 字符），
>   发 `/g`（`/get` `/cont`）逐条取出，显示进度（`done/total` + 剩余条数），
>   发 `/x`（`/gc`）清除待续发内容

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
| `.wechat-filter.json` | 信息过滤级别 + 超长回复策略持久化存储（full/pad/phone + quota） |
| `.wechat-adapter.log` | 运行时日志（超 200MB 自动截断至 100MB） |
| `.tool-versions.json` | 版本锁定文件（setup.bat 读取此文件安装/校验版本） |

## 测试

基于 Vitest v4 + v8 覆盖率，测试 `src/utils.js` 的纯函数和 `wechat-adapter.js` 的集成逻辑。

```bash
npm test              # 运行全部 164 个测试
npm run test:coverage # 运行并生成覆盖率报告
npm run test:watch    # 监听模式
```

**测试覆盖：**

| 文件 | 类型 | 覆盖功能 | 用例 |
|------|------|---------|------|
| `tests/unit/utils/helpers.test.js` | 单元 | `levelIcon`/`levelDesc`/`levelLabel`/`quotaModeLabel`/`summarizeText`/`resolveFilterLevel`/`resolveQuotaMode`/`getAllQuestions`/`parseWorkspaceArg`/`parseSessionIndex`/`formatDuration`/`normalizeDir`/`wsPathEqual`/`makeWsName`/`formatReply`/`formatToolInput`/`splitContinuationMessages` | 81 |
| `tests/unit/utils/edge-cases.test.js` | 单元 | 上述函数的 null/undefined/空串/边界值/特殊路径极限输入 | 47 |
| `tests/unit/utils/question.test.js` | 单元 | `formatQuestionBody`（问答提示拼接） | 11 |
| `tests/unit/utils/notification.test.js` | 单元 | `formatReply` 对 OpenAI/Claude 输出格式的处理 | 7 |
| `tests/integration/event-format.test.js` | 集成 | `eventToNotification` 实际调用（8 种 SSE 事件 → 中文通知） | 4 |

当前 **164 测试 / 0 失败 / 100% 覆盖率**（114 stmts / 101 branches / 26 funcs / 85 lines）。
