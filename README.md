# Claude Code Remote

通过飞书 Bot 远程控制 Claude Code CLI。在手机上接收实时消息推送、审批工具调用、发送指令。

## 架构概览

```
┌──────────────┐     WS 长连接      ┌──────────────────┐
│   飞书 Bot    │◄──────────────────►│   FeishuClient    │
│  (手机/桌面)  │                    │   (WSClient)      │
└──────────────┘                    ├──────────────────┤
                                    │   BridgeServer    │
                                    │   (HTTP :9876)    │
                                    ├──────────────────┤
┌──────────────┐    Hook 回调       │   SessionRouter   │
│ Claude Code  │───────────────────►│   ApprovalManager │
│  (tmux 内)   │  /hook /register   │   MessageQueue    │
└──────────────┘                    │   MessageInjector │
                                    └──────────────────┘
```

核心组件：

| 组件 | 路径 | 职责 |
|------|------|------|
| **BridgeServer** | `src/bridge/server.ts` | HTTP 服务器，接收 CC Hook 回调、处理审批、Stop Hook 消费 |
| **FeishuClient** | `src/bridge/feishu-client.ts` | 飞书长连接客户端，收发消息、卡片交互、`/unbind` 断开 |
| **SessionRouter** | `src/bridge/router.ts` | CC 实例注册表，无自动超时清理（仅飞书可断开） |
| **ApprovalManager** | `src/bridge/approval.ts` | 审批队列管理，超时自动清理 |
| **MessageQueue** | `src/bridge/message-queue.ts` | 消息队列，飞书消息暂存与 Stop Hook 消费 |
| **MessageInjector** | `src/bridge/message-injector.ts` | 空闲消息注入器，通过 tmux send-keys 注入（熄屏/锁屏可用） |
| **/remote Skill** | `src/skill/remote.md` | CC 内置 Skill，引导连接注册（必须 tmux 环境） |

### 消息流转

```
飞书用户发消息 → FeishuClient 收到 → MessageQueue.enqueue()
                                         ↓
                                  ┌──────┴──────┐
                                  ↓             ↓
                           Stop Hook         MessageInjector
                           (CC 停止时)       (CC 空闲时)
                                  ↓             ↓
                           block + 注入      tmux send-keys
                           CC 继续运行       (熄屏/锁屏可用)
```

## 快速开始

### 前置条件

- Node.js >= 18
- **tmux**（必须，支持熄屏/锁屏状态下远程控制）
- 飞书企业自建应用（需开通机器人能力 + 长连接订阅）
- Claude Code CLI
- 平台：macOS / Linux

### 1. 安装

```bash
# 安装 tmux（如未安装）
brew install tmux        # macOS
sudo apt install tmux    # Linux

# 全局安装 claude-remote
npm install -g claude-code-remote
```

> 也可以不安装，直接用 `npx claude-code-remote init` 代替 `claude-remote init`。

### 2. 初始化配置

```bash
claude-remote init
```

按提示输入：
- **Feishu App ID** — 飞书开发者后台获取
- **Feishu App Secret** — 飞书开发者后台获取
- **Server port** — Bridge HTTP 端口（默认 9876）
- **Allowed users** — 飞书用户 `open_id` 白名单（逗号分隔）

配置文件保存在 `~/.claude-remote/config.json`：

```json
{
  "feishu": {
    "appId": "cli_xxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "server": { "port": 9876, "host": "127.0.0.1" },
  "allowedUsers": ["ou_xxxxxxxxxxxxxxxx"],
  "heartbeatInterval": 30000,
  "sessionTimeout": 300000
}
```

### 3. 飞书应用配置

在 [飞书开发者后台](https://open.feishu.cn/app) 中：

1. 创建**企业自建应用**
2. 开通**机器人**能力
3. 在 **事件与回调** 中：
   - 订阅方式选择 **「使用长连接接收回调」**
   - 添加事件订阅：**接收消息 (im.message.receive_v1)**
   - 添加回调订阅：**卡片回传交互 (card.action.trigger)**
4. 发布应用版本并让管理员审批

### 4. 启动 Bridge 服务

```bash
claude-remote start
```

### 5. 在 tmux 中启动 CC 并连接

```bash
# 创建 tmux 会话
tmux new -s claude

# 在 tmux 中启动 Claude Code
claude

# 在 CC 中输入
/remote
```

Skill 会自动检测 tmux 环境，注册会话并安装 Hook。

## 使用指南

### 飞书端命令

| 命令 | 说明 |
|------|------|
| `/list` | 查看所有在线 CC 实例 |
| `/bind <session_id>` | 绑定到指定 CC 实例 |
| `/unbind` | 断开连接并注销会话 |
| `/status` | 查看当前绑定状态 |
| *(任意文本)* | 转发到绑定的 CC 实例 |

### 消息推送类型

| Hook 事件 | 飞书展示形式 |
|-----------|-------------|
| **Notification** | 蓝色标题富文本卡片（CC 回复内容） |
| **PostToolUse** | 工具结果卡片（工具名 + 输出内容） |
| **PreToolUse** | 交互审批卡片（工具详情 + 允许/拒绝按钮） |
| **Stop** | CC 回复转发到飞书 + 消费消息队列 |

### 审批流程

1. CC 执行需审批的工具（如 Bash 命令、文件写入等）
2. Bridge 向绑定用户发送交互卡片，显示工具详情（命令内容、文件路径等）
3. 用户在飞书中点击「允许」或「拒绝」
4. 审批超时（5 分钟）自动拒绝

### 断开连接

CC 端无法主动断开连接。只能通过飞书发送 `/unbind` 断开：
- 解除用户绑定
- 从 Bridge 注销会话
- 清理审批请求

### 远程指令发送

飞书消息通过两条路径送达 CC：

1. **Stop Hook 消费**（主路径）：CC 即将停止时触发 Stop Hook，检测到队列有消息则 block CC 并注入
2. **空闲注入**（补充路径）：CC 空闲时，MessageInjector 通过 `tmux send-keys` 注入（熄屏/锁屏状态下也能工作）

## CLI 命令

```bash
claude-remote init      # 交互式配置
claude-remote start     # 启动 Bridge 守护进程
claude-remote stop      # 停止 Bridge
claude-remote status    # 查看进程状态 + 在线会话列表
claude-remote log       # 查看日志（-n 100 指定行数，-f 实时追踪）
```

## HTTP API

Bridge 在 `http://127.0.0.1:9876` 上提供以下端点：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/register` | POST | 注册 CC 实例，返回 Token |
| `/unregister` | POST | 注销 CC 实例（需 X-Token） |
| `/hook` | POST | 接收 CC Hook 回调（需 X-Token） |
| `/status` | GET | 查看 Bridge 状态和在线会话 |
| `/card` | POST | 飞书卡片回调（HTTP 模式备用） |

## 安全机制

| 机制 | 实现 |
|------|------|
| **Token 认证** | `crypto.randomBytes(32)` 生成，`timingSafeEqual` 恒定时间比较 |
| **用户白名单** | `config.allowedUsers` 限制飞书用户 `open_id` |
| **本地监听** | HTTP 仅绑定 `127.0.0.1` |
| **仅飞书可断开** | CC 端无法主动断开，防止误操作 |
| **审批超时** | 5 分钟未响应自动拒绝 |

## 项目结构

```
claude-code-remote/
├── bin/claude-remote.js          # CLI 入口
├── src/
│   ├── bridge/
│   │   ├── entry.ts              # Bridge 主入口
│   │   ├── server.ts             # HTTP 服务器 + Hook 处理 + 审批逻辑
│   │   ├── feishu-client.ts      # 飞书客户端 + 命令路由 + /unbind
│   │   ├── router.ts             # CC 实例注册表（无自动超时清理）
│   │   ├── approval.ts           # 审批队列管理
│   │   ├── message-queue.ts      # 消息队列
│   │   └── message-injector.ts   # 空闲注入器（tmux send-keys）
│   ├── cli/*.ts                  # CLI 命令
│   ├── utils/*.ts                # 配置、认证、日志等工具
│   ├── skill/remote.md           # /remote Skill 定义
│   └── __tests__/                # 单元测试
├── templates/settings-hooks.json # Hook 配置模板
└── docs/OPERATION-GUIDE.md       # 操作手册
```

## 开发

```bash
npm install && npm run build
npm test               # 运行测试
npm run dev             # 编译并监听
```

## 技术栈

| 依赖 | 用途 |
|------|------|
| `@larksuiteoapi/node-sdk` | 飞书 SDK（WSClient + API Client） |
| `commander` | CLI 命令框架 |
| `pino` | 结构化日志 |
| `typescript` | 类型安全 |
| `vitest` | 单元测试 |

## 已知限制

- **必须 tmux**：消息注入依赖 `tmux send-keys`，非 tmux 环境无法注册
- **飞书 SDK 卡片回调**：WSClient 默认丢弃 card 类型，需 monkey-patch 修复
- **长连接仅限企业自建应用**
- **单机部署**：设计为单机本地运行
- **仅支持 macOS / Linux**

## License

MIT
