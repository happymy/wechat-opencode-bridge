# WeChat Opencode Bridge

通过微信远程操控 [OpenCode](https://opencode.ai) CLI 的适配器。基于 ACP (Agent Communication Protocol) 协议，使用 `wechat-acp` 作为微信 Bot 中间件。

## 功能

- 微信中发送消息给 OpenCode AI 会话，接收流式回复
- 三级信息过滤：FULL（全部）/ PAD（摘要）/ PHONE（极简）
- 会话管理：列表、切换、新建
- 模式切换：plan / build
- 问题回答与权限审批（通知中直接回复即可）
- 主动通知：SSE 事件推送到微信
- 多个 OpenCode 工作区管理

## 快速开始

```bash
# 安装依赖
npm install -g wechat-acp

# 启动（restart-wechat.bat 会处理启动和登录）
restart-wechat.bat
```

首次启动需扫描二维码登录微信。之后会自动保持登录状态。

## 命令列表

### 会话管理
| 命令 | 别名 | 说明 |
|------|------|------|
| `/list` | `/l`, `/ls`, `/sessions` | 查看会话列表 |
| `/switch` | `/s`, `/sw` | 切换会话 |
| `/new` | `/nl`, `/create` | 新建会话 |

### 模式切换
| 命令 | 别名 | 说明 |
|------|------|------|
| `/plan` | `/pl` | plan 模式 |
| `/build` | `/bu` | build 模式 |

### 信息过滤
| 命令 | 说明 |
|------|------|
| `/level` 或 `/lvl` | 查看/设置过滤级别 |
| `/f` | FULL 模式（全部显示） |
| `/pd` | PAD 模式（摘要显示，默认） |
| `/ph` | PHONE 模式（极简，仅文字） |

### 问题与权限
| 命令 | 别名 | 说明 |
|------|------|------|
| `/answer` | `/ans` | 回答 AI 提问 |
| `/skip` | `/pass`, `/ps` | 跳过问题 |
| `/qlist` | `/ql`, `/questions` | 待回答问题列表 |
| `/allow` | `/a` | 批准权限 |
| `/deny` | `/d` | 拒绝权限 |
| `/trust` | `/t` | 信任权限 |
| `/plist` | `/p`, `/pending` | 待审批权限列表 |

### 系统
| 命令 | 别名 | 说明 |
|------|------|------|
| `/workspace` | `/ws` | 工作区管理 |
| `/sd` | - | 从 DB 同步工作区 |
| `/status` | `/st` | 任务运行状态 |
| `/cancel` | `/c` | 取消当前任务 |
| `/mute` | `/m` | 开关主动通知 |
| `/notify` | `/n` | 通知与订阅信息 |
| `/help` | `/h` | 帮助信息 |

## 配置

环境变量：

- `OPENCODE_SERVER` — OpenCode HTTP 服务地址（默认 `http://localhost:4096`）
- `OPENCODE_AUTH` — HTTP Basic Auth 凭证（默认 `opencode:opencode`）

## 架构

```
微信 → wechat-acp → ACP/stdio → wechat-adapter.js → HTTP API → OpenCode Server
                                                    → SSE/Event → 主动通知
```

`wechat-adapter.js` 作为 ACP Agent，通过 stdio 与 `wechat-acp` 通信，同时通过 HTTP API 与 OpenCode Server 交互。SSE 事件流用于接收主动通知并推送到微信。

## 协议

项目遵循 ACP (Agent Communication Protocol) 规范，使用 JSON-RPC 2.0 over stdio 作为通信协议。

## 许可证

MIT
