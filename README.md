# work — OpenCode 开发工作区

OpenCode + pk-opencode-webui + WeChat 机器人集成工作区。

## 结构

```
work/
├── pk-opencode-webui/    # 第三方 OpenCode Web UI（独立 git 仓库）
├── wechat-adapter.js     # WeChat 机器人适配器
├── start-all.bat         # 一键启动所有服务
├── stop-all.bat          # 停止所有服务
├── web.bat               # 启动 OpenCode Web UI
├── run.bat               # 运行任务
├── wechat-bridge.bat     # WeChat 桥接启动
├── del.py                # 临时清理工具
├── dev.db                # OpenCode 开发数据库
├── sqlite_mcp_server.db  # SQLite MCP 数据库
├── package.json          # Node.js 依赖
└── README.md
```

## 服务

| 服务 | 端口 | 说明 |
|------|------|------|
| OpenCode Web | 4096 | 官方 Web UI，需 Basic Auth |
| pk-opencode-webui | 2048 | 第三方 Web UI |
| WeChat bot | — | 微信机器人，共享 session |

## 启动

```bash
start-all.bat
```

或单独启动：

```bash
web.bat            # OpenCode Web UI + pk-opencode-webui
wechat-bridge.bat  # WeChat 机器人
```

## 认证

OpenCode Web UI（端口 4096）：
- 用户名：`opencode`
- 密码：`opencode`

pk-opencode-webui（端口 2048）直接使用，无需额外认证。

## WeChat 机器人

`wechat-adapter.js` 是基于 wechat-acp 的微信机器人适配器，通过 OpenCode API 管理会话，支持：
- 查看会话列表 / 切换会话
- 新建任务 / 重命名 / 删除会话
- 工作区管理
