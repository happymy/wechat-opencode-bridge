# WeChat Opencode Bridge 实现计划

## 概述

将 Opencode CLI 的输出转发到微信，通过 `wechat-acp` 的 `opencode` 预设实现双向通信。让用户通过微信 Bot 实现 Opencode CLI 的全功能控制。

`wechat-acp` 已内置 `opencode` 预设，使用 ACP 协议通过 stdio 与 `opencode` 进程通信。本项目的核心工作在于：
1. 实现三级信息过滤（FULL/PAD/PHONE）
2. 为所有 Opencode CLI 命令添加别名
3. 处理 ACP 协议无法覆盖的补充功能

---

## 一、通信架构分析

### 1.1 现有基础设施

| 组件 | 说明 |
|------|------|
| `wechat-acp` | 已内置 `opencode` 预设，直接 `npx wechat-acp --agent opencode` 即可使用 |
| ACP 协议 | Agent Communication Protocol，通过 stdio 的 JSON-RPC 风格通信 |
| `@opencode-ai/sdk` | 官方 REST API SDK，支持 Session、Event 管理等 |

### 1.2 ACP 协议能力边界

`wechat-acp` 通过 ACP 协议与 opencode 通信，支持：

- **prompt**：发送用户消息，接收 agent 回复 (流式)
- **session/cancel**：取消当前任务
- **configOptions**：动态获取/设置配置（model、mode、reasoning_effort 等）
- **文件/I片**：通过 resource block 内联嵌入

**ACP 协议不支持的 opencode CLI 功能：**

| 功能 | CLI 命令 | ACP 支持 | 替代方案 |
|------|---------|----------|---------|
| 会话管理(列表/切换/删除) | `opencode session` | ❌ | 通过 `@opencode-ai/sdk` REST API |
| 工作区文件读取 | 文件系统 | ❌ | 直接读取本地 SQLite DB (`~/.local/share/opencode/`) |
| 项目结构浏览 | - | ❌ | 文件系统读取 + `list_files` |
| 主题切换 | `opencode theme` | ❌ | 配置文件读写 |
| 插件管理 | `opencode plugin` | ❌ | 配置文件读写 |
| Git 操作 | - | ❌ | 直接执行 git 命令 |
| 运行模式切换 | `opencode run` | ❌ | 重新启动 agent 进程 |

### 1.3 类似项目参考 (来自 awesome-opencode)

| 项目 | 平台 | 特点 |
|------|------|------|
| `opencode-telegram-bot` | Telegram | 手机上运行/监控 AI 编码任务 |
| `kimaki` | Discord | Discord 远程控制 opencode |
| `open-dispatch` | Slack/Teams | 桌面启动，手机端引导 |
| `golembot` | 多 IM | 统一多 Agent CLI 框架，Skill 系统 |

---

## 二、三级信息过滤系统

### 2.1 信息种类分析

Opencode 会话中包含以下信息类型：

| 类型 | 说明 | CLI | 桌面WebUI | 移动WebUI |
|------|------|-----|----------|----------|
| `assistant_message` | AI 文本回复 | ✅ 全部 | ✅ 全部 | ✅ 全部 |
| `tool_call` | 工具调用声明 | ✅ 全部 | ✅ 全部 | ⚠️ 摘要 |
| `tool_output` | 工具执行结果 | ✅ 全部 | ✅ 截断 | ❌ 隐藏 |
| `file_diff` | 文件差异 | ✅ 全部 | ✅ 截断 | ❌ 隐藏 |
| `thinking` | 思维链 | ✅ 全部 | ✅ 全部 | ⚠️ 摘要 |
| `system_prompt` | 系统提示词 | ❌ 隐藏 | ❌ 隐藏 | ❌ 隐藏 |
| `permission_request` | 权限请求 | ✅ 交互 | ✅ 交互 | ✅ 简化 |
| `command_output` | 命令执行输出 | ✅ 全部 | ✅ 截断 | ❌ 隐藏 |
| `subagent_task` | 子代理任务 | ✅ 全部 | ⚠️ 摘要 | ❌ 隐藏 |
| `error` | 错误信息 | ✅ 全部 | ✅ 全部 | ✅ 概要 |
| `status_update` | 状态更新 | ✅ 全部 | ✅ 全部 | ❌ 隐藏 |
| `file_reference` | 文件引用 | ✅ 全部 | ⚠️ 路径 | ❌ 隐藏 |
| `search_result` | 搜索结果 | ✅ 全部 | ✅ 截断 | ❌ 隐藏 |

### 2.2 三级过滤方案

#### FULL (对应 CLI 体验)
- 转发所有信息，不做任何过滤
- 工具调用声明、完整输出、思维链全部保留
- 文件差异完整转发（受微信长度限制会自动分段）
- 适用场景：深度开发、调试

#### PAD (对应桌面 WebUI 体验)
- **保留**：AI 文本回复、错误信息、权限请求、状态更新
- **摘要**：子代理任务（仅显示名称+状态）
- **截断**：工具输出（前 500 字符 + 行数摘要）、文件引用（仅路径）、搜索结果（前 5 条）
- **隐藏**：系统提示词
- 适用场景：日常编码、Code Review

#### PHONE (对应移动 WebUI 体验)
- **保留**：AI 文本回复、错误信息（概要）
- **摘要**：思维链（前 100 字符）
- **截断**：权限请求（简化交互）
- **隐藏**：工具调用声明、工具输出、文件差异、命令输出、子代理任务、搜索果、文件引用
- 适用场景：快速问答、状态查询

### 2.3 过滤实现策略

```
                    ┌─────────────┐
微信消息 ──────────▶│ wechat-acp   │
                    │ (ACP协议)   │
                    └──────┬──────┘
                           │ stdout (SSE stream)
                           ▼
                    ┌──────────────┐
                    │  过滤中间层  │  ◀── 本项目新增
                    │              │
                    │  FULL  模式  │────▶ 原文转发
                    │  PAD   模式  │────▶ 截断/摘要后转发
                    │  PHONE 模式  │────▶ 精简后转发
                    └──────────────┘
```

---

## 三、命令别名系统

### 3.1 设计原则

- 所有别名使用 2-4 个字母，降低输入成本
- 默认用户发送的纯文本就是对话内容
- 以 `/` 开头的消息视为命令

### 3.2 别名映射表

#### 会话控制

| 别名 | 命令 | 说明 |
|------|------|------|
| `/nl` | `/session new` | 新建会话 |
| `/sw` | `/session switch <id>` | 切换会话 |
| `/ls` | `/session list` | 列出会话 |
| `/rm` | `/session delete <id>` | 删除会话 |
| `/mv` | `/session rename <id> <name>` | 重命名会话 |
| `/h`  | `/session history` | 会话历史 |
| `/ct` | `/context` | 查看/管理上下文 |

#### 信息级别切换

| 别名 | 命令 | 说明 |
|------|------|------|
| `/f`  | `/level full` | 切换到 FULL 模式 |
| `/p`  | `/level pad` | 切换到 PAD 模式 |
| `/ph` | `/level phone` | 切换到 PHONE 模式 |

#### Agent 控制

| 别名 | 命令 | 说明 |
|------|------|------|
| `/c`  | `/acp-cancel` | 取消当前任务 |
| `/ca` | `/acp-cancel all` | 取消所有任务 |
| `/m`  | `/model` | 查看/切换模型 |
| `/md` | `/mode` | 查看/切换 agent 模式 |
| `/re` | `/reasoning` | 设置推理深度 |

#### 工作区操作

| 别名 | 命令 | 说明 |
|------|------|------|
| `/wf` | `/workspace files` | 列出工作区文件 |
| `/wd` | `/workspace dir` | 查看目录结构 |
| `/wr` | `/workspace read <file>` | 读取文件内容 |
| `/ws` | `/workspace search <pattern>` | 搜索文件内容 |

#### 系统

| 别名 | 命令 | 说明 |
|------|------|------|
| `/st` | `/status` | 系统状态 |
| `/hl` | `/help` | 帮助信息 |

### 3.3 命令解析流程

```
用户发送消息
      │
      ▼
 以 "/" 开头？
    ├── 是 ──▶ 命令解析器 ──▶ 执行对应动作
    │
    └── 否 ──▶ 作为对话内容发送给 opencode (prompt)
```

---

## 四、补充功能实现

### 4.1 会话管理 (通过 @opencode-ai/sdk REST API)

```typescript
// 列会话
const sessions = await client.session.list();

// 创建会话
const session = await client.session.create({ title: "新会话" });

// 切换会话 → 更新 wechat-acp 内部映射

// 删除会话
await client.session.delete(sessionId);
```

### 4.2 工作区文件读取 (本地 DB/文件系统)

```
opencode 数据存储路径:
  ~/.local/share/opencode/  (Linux)
  ~/Library/Application Support/opencode/  (macOS)
  %APPDATA%/opencode/  (Windows)

内部 SQLite DB 结构包含:
  - sessions 表: 会话信息
  - messages 表: 消息历史
  - 项目工作区路径引用
```

当 REST API 不可用时，直接读取 SQLite DB 获取会话信息和消息历史。

### 4.3 跨平台数据路径

| 平台 | SQLite DB 路径 |
|------|---------------|
| Windows | `%APPDATA%/opencode/data.db` 或 `~/.local/share/opencode/` |
| macOS | `~/Library/Application Support/opencode/` |
| Linux | `~/.local/share/opencode/` |

---

## 五、技术实现方案

### 5.1 项目结构

```
wechat-opencode-bridge/
├── src/
│   ├── index.ts          # 入口，启动 wechat-acp + opencode
│   ├── filter/
│   │   ├── index.ts      # 过滤引擎
│   │   ├── full.ts       # FULL 模式(直通)
│   │   ├── pad.ts        # PAD 模式过滤器
│   │   └── phone.ts      # PHONE 模式过滤器
│   ├── commands/
│   │   ├── index.ts      # 命令解析器
│   │   ├── session.ts    # 会话管理命令
│   │   ├── level.ts      # 过滤级别切换命令
│   │   └── workspace.ts  # 工作区命令
│   ├── sdk/
│   │   ├── client.ts     # opencode SDK 客户端
│   │   └── fallback.ts   # DB 直接读取的后备方案
│   └── config.ts         # 配置管理
├── config/
│   └── default.json      # 默认配置(别名、过滤规则)
└── plan/
    └── plan.md
```

### 5.2 运行方式

```bash
# 直接使用 wechat-acp + opencode 预设
npx wechat-acp --agent opencode --cwd /path/to/project

# 使用本项目包装 (带过滤层)
node dist/index.js --level pad --cwd /path/to/project
```

### 5.3 配置示例

```json
{
  "agent": {
    "preset": "opencode",
    "cwd": "D:/code/project"
  },
  "filter": {
    "defaultLevel": "pad",
    "maxReplyLength": 4000,
    "toolOutputMaxLines": 500,
    "searchResultMaxCount": 5,
    "thinkingMaxLength": 100
  },
  "commandAliases": {
    "/acp-cancel": ["/c", "/取消"],
    "/acp-config": ["/cfg", "/设置"]
  },
  "commands": {
    "/nl": { "action": "session.new" },
    "/sw": { "action": "session.switch", "args": ["id"] },
    "/ls": { "action": "session.list" },
    "/f":  { "action": "level.set", "args": ["full"] },
    "/p":  { "action": "level.set", "args": ["pad"] },
    "/ph": { "action": "level.set", "args": ["phone"] },
    "/c":  { "action": "cancel" },
    "/ca": { "action": "cancelAll" },
    "/st": { "action": "status" },
    "/hl": { "action": "help" },
    "/wf": { "action": "workspace.files" },
    "/wd": { "action": "workspace.dir" }
  }
}
```

---

## 六、实施步骤

### Phase 1: 研究与验证 (Day 1)
1. [x] 分析 opencode 源码结构，确认信息粒度差异
2. [x] 确认 wechat-acp 的 opencode 预设可用性
3. [x] 确认 @opencode-ai/sdk REST API 能力边界
4. [ ] 在本地运行 `wechat-acp --agent opencode` 验证端到端通信
5. [ ] 抓取 opencode ACP 输出流，分析消息类型结构

### Phase 2: 核心过滤系统 (Day 2-3)
6. [ ] 实现消息类型解析器（解析 opencode stdout 中的各种消息类型）
7. [ ] 实现 FULL/PAD/PHONE 三级过滤器
8. [ ] 实现过滤级别动态切换
9. [ ] 编写单元测试

### Phase 3: 命令系统 (Day 3-4)
10. [ ] 实现命令解析器（`/` 前缀识别 + 纯文本对话区分）
11. [ ] 实现会话管理命令（通过 SDK REST API + DB fallback）
12. [ ] 实现工作区文件读取命令
13. [ ] 实现状态查看、帮助等系统命令
14. [ ] 实现别名映射

### Phase 4: 集成与打磨 (Day 5)
15. [ ] 集成过滤层到 wechat-acp
16. [ ] 配置文件加载与验证
17. [ ] 错误处理与日志
18. [ ] 端到端测试
19. [ ] 编写 README 文档

---

## 七、待确认问题

1. opencode 的 ACP 输出流中有哪些具体的消息类型？需要运行后抓取分析
2. `@opencode-ai/sdk` 的 session API 是否支持完整的 CRUD？
3. opencode 的 SQLite DB 结构细节（表名、字段）
4. 微信消息长度限制（当前预估 2048 字符，需验证 wechat-acp 的分段策略）