# Feature: 20260403_F001 - feishu-remote-control

## 需求背景

Claude Code 是一个强大的 AI 编程助手，但用户必须坐在电脑前才能与之交互。在实际工作中，开发者经常需要离开电脑（如开会、通勤、休息），但希望能在手机上继续跟踪和操控 Claude Code 的任务进度。

目前没有一种方式能将 Claude Code 的交互能力延伸到移动端。用户无法在手机上查看 CC 的输出、审批工具调用、下发新指令或执行 `/` 命令。

飞书作为企业级通讯工具，提供了完善的机器人 API 和长连接模式，无需公网服务器即可实现双向实时通信，是作为移动端控制入口的理想选择。

## 目标

- 实现通过飞书机器人远程控制电脑端 Claude Code 的能力
- 支持双向通信：CC 输出/审批推送 → 飞书，飞书指令/控制命令 → CC
- 适配 Linux / macOS / Windows 三平台
- 支持多实例管理（单机多实例 + 多机多实例）
- 提供双重认证（飞书用户身份 + CC 实例 token）
- 以 NPM 全局包形式交付，安装即用

## 方案设计

### 整体架构

![整体架构图](./images/01-architecture.png)

系统由三个核心组件组成：

1. **`claude-code-remote` NPM 包**：全局安装后提供 `claude-remote` CLI 命令，负责启动/停止 bridge 进程、初始化飞书配置、自动注入 Claude Code hooks
2. **Bridge 进程**：Node.js 本地后台进程，使用飞书 SDK 长连接模式与飞书机器人通信，同时暴露 HTTP 端点接收 Claude Code hooks 回调
3. **`/remote` Skill + Claude Code Hooks**：Skill 作为 CC 内斜杠命令触发连接注册，Hooks 捕获各类事件通过 HTTP 回调 bridge

启动流程：

```
1. npm install -g claude-code-remote
2. claude-remote init          # 配置飞书 App ID/Secret
3. claude-remote start         # 启动 bridge 后台进程
4. 在 Claude Code 中输入 /remote  # 注册 CC 实例，建立远程连接
```

### 消息流设计

![消息流图](./images/02-data-flow.png)

#### CC → 飞书（输出推送）

| 触发事件 | Hook 类型 | 飞书消息形式 |
|---------|----------|------------|
| 文本输出 | Notification | 富文本消息（含代码块） |
| 工具调用结果 | PostToolUse | 卡片消息（可折叠详情） |
| 审批请求 | PreToolUse | 交互卡片（动态多选按钮） |
| `/` 命令结果 | Notification | 富文本消息 |

Hook 回调 payload 格式：

```typescript
interface HookPayload {
  type: 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';
  session_id: string;      // CC 实例 token
  request_id?: string;     // 审批请求唯一 ID
  content: string;         // 事件内容（JSON string）
  tool_name?: string;      // 工具名称
  approval_needed?: boolean;
}
```

#### 飞书 → CC（指令下发）

| 飞书操作 | 说明 |
|---------|------|
| 发送文本 | 作为用户输入注入 CC |
| 点击审批按钮 | 匹配审批队列，返回对应选项 |
| 发送 `/` 命令 | 映射为 CC 斜杠命令执行 |
| 发送控制指令 | 如 `/stop` 停止当前任务、`/clear` 清空上下文 |

#### 飞书 → CC 消息注入机制

飞书 → CC 方向的消息注入依赖双机制方案，覆盖 CC 两种运行状态：

**机制 1：Stop Hook 注入（CC 工作中）**

当 CC 的 agent 完成当前任务考虑停止时，`Stop` Hook 触发。Hook 通过 curl 调用 Bridge 检查消息队列：

```
CC 完成任务 → Stop Hook 触发 → curl /hook (type=Stop)
→ Bridge 检查 MessageQueue
→ 有消息: 返回 {decision: "block", reason: "飞书消息内容"}
   → CC 取消停止，继续执行新指令
→ 无消息: 返回 {decision: "approve"}
   → CC 正常停止，等待用户输入
```

Stop Hook 返回格式：

```json
{
  "decision": "block",
  "reason": "用户通过飞书发送了 2 条新消息:\n[1] 请检查 test.py 的单元测试\n[2] 检查完顺便修复一下 lint 错误",
  "systemMessage": "飞书远程消息:\n[1] 请检查 test.py 的单元测试\n[2] 检查完顺便修复一下 lint 错误"
}
```

**机制 2：Message Injector 注入（CC 空闲中）**

当 CC 已完成任务等待用户输入时，无 Hook 会触发。此时由 Bridge 内置的 MessageInjector 后台进程处理：

```
飞书消息 → Bridge MessageQueue 存入
→ MessageInjector 轮询（3秒间隔）
→ 检测到消息 + CC 空闲（最近 5 秒无 Hook 活动）
→ 通过终端注入机制输入文本:
   macOS: osascript -e 'tell application "System Events" to keystroke "..."'
   Linux: xdotool type --clearmodifiers "..."  或  tmux send-keys
→ 注入回车键发送消息
→ 飞书收到确认: "消息已注入到 CC 会话"
```

MessageInjector 需要的信息：
- CC 终端的窗口标识（tmux session/pane 或 Terminal.app window）
- 在 `/remote` 注册时由 Skill 收集并传递给 Bridge

**注入决策流程：**

```
飞书消息到达 → FeishuClient.handleMessage()
  ↓
消息存入 MessageQueue (per-session)
  ↓
CC 状态判断:
  ├─ 最近 5 秒有 Hook 活动 → CC 工作中
  │   → 等待 Stop Hook 触发时消费队列
  │
  └─ 最近 5 秒无 Hook 活动 → CC 空闲
      → MessageInjector 在下一个轮询周期注入
```

#### 通用审批模型

审批系统采用动态多选模型，支持任意数量和类型的选项：

```typescript
interface ApprovalRequest {
  type: 'PreToolUse' | 'custom';
  session_id: string;
  request_id: string;
  message: string;             // 审批提示文案
  options: ApprovalOption[];   // 动态选项列表
}

interface ApprovalOption {
  id: string;                  // 选项标识
  label: string;               // 显示文本
  style: 'primary' | 'danger' | 'default';
  value: string;               // 返回值
}
```

示例场景：

- **工具调用审批**：允许 / 拒绝 / 始终允许（三个选项）
- **方案选择**：方案 A 重构 / 方案 B 新建 / 方案 C 忽略（多选一）
- **文件选择**：列出多个候选文件供用户选择

飞书侧使用交互卡片动态渲染按钮，选项数量和内容由 CC hook 回调动态决定。

### 连接生命周期

![连接状态机](./images/03-state.png)

CC 实例的远程连接经历以下状态：

1. **离线（offline）**：CC 启动，未建立远程连接
2. **注册中（registering）**：用户输入 `/remote`，向 bridge 发送注册请求
3. **在线（online）**：注册成功，双向通信建立
4. **断开（disconnected）**：bridge 检测到心跳丢失或用户主动 `/remote off`

状态转换：
- `offline` → `registering`：用户执行 `/remote`
- `registering` → `online`：bridge 返回 token，hooks 开始工作
- `registering` → `offline`：注册失败（bridge 未启动等）
- `online` → `disconnected`：心跳超时 / 网络中断
- `online` → `offline`：用户执行 `/remote off` 或 CC 进程退出
- `disconnected` → `registering`：自动重连

### 多实例路由

```
┌─ 机器 A ────────────────────────────┐
│  Bridge A ◄──► CC 实例 1 (token-a1) │
│           ◄──► CC 实例 2 (token-a2) │
└──────────────────────────────────────┘
┌─ 机器 B ────────────────────────────┐
│  Bridge B ◄──► CC 实例 1 (token-b1) │
└──────────────────────────────────────┘
```

- 每台机器运行独立的 bridge 进程，各自维护飞书长连接
- 每个 CC 实例通过 `/remote` 注册时获取唯一 token
- 飞书通过会话上下文（chat_id + 用户选择）定位目标 CC 实例
- 用户在飞书中可切换不同 CC 实例进行操控
- 每个实例有独立的消息队列，互不干扰

### 安全机制

#### 双重认证

1. **飞书用户认证**：bridge 配置 `allowed_users`（飞书 open_id 白名单），只响应授权用户的消息
2. **CC 实例认证**：
   - `/remote` 注册时 bridge 生成随机 token（256-bit）
   - hooks 回调时在 HTTP header 中携带 token 验证
   - token 存储在 CC 本地 `.claude/remote-token`

#### 通信安全

- Bridge 与飞书之间：飞书 SDK 自动处理 TLS 加密
- Bridge 与 CC hooks 之间：本地 HTTP，默认仅监听 `127.0.0.1`
- Token 不在日志中明文输出

### 组件设计

#### CLI 命令

| 命令 | 说明 |
|------|------|
| `claude-remote init` | 初始化配置（飞书 App ID/Secret、端口等） |
| `claude-remote start` | 启动 bridge 后台进程 |
| `claude-remote stop` | 停止 bridge 进程 |
| `claude-remote status` | 查看连接状态和已注册的 CC 实例 |
| `claude-remote log` | 查看 bridge 日志 |

#### `/remote` Skill

- 安装位置：`.claude/skills/`
- 触发方式：`/remote`、`/remote on`、`/remote off`、`/remote status`
- 执行逻辑：
  - `on`（默认）：向 bridge 发送注册请求 → 获取 token → 写入 hooks 配置（含 Stop hook）
  - `off`：通知 bridge 注销 → 清理 token
  - `status`：显示当前连接状态
- 注册时额外收集终端信息：
  - 检测是否在 tmux 会话中（`$TMUX` 环境变量）
  - 记录 tmux session/pane 标识
  - 如非 tmux，记录 Terminal.app 为注入目标

#### Claude Code Hooks 配置

由 `claude-remote init` 或 `/remote` 自动注入到 `.claude/settings.json`：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "command": "curl -s -X POST http://127.0.0.1:9876/hook -H 'X-Token: $REMOTE_TOKEN' -d '$PAYLOAD'"
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "command": "curl -s -X POST http://127.0.0.1:9876/hook -H 'X-Token: $REMOTE_TOKEN' -d '$PAYLOAD'"
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "command": "curl -s -X POST http://127.0.0.1:9876/hook -H 'X-Token: $REMOTE_TOKEN' -d '$PAYLOAD'"
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "command": "curl -s -X POST http://127.0.0.1:9876/hook -H 'X-Token: $REMOTE_TOKEN' -d '$PAYLOAD'"
      }
    ]
  }
}
```

#### MessageQueue（消息队列）

Per-session 消息队列，存储飞书下发的待注入消息：

```typescript
class MessageQueue {
  // 按 session token 分组的消息队列
  private queues: Map<string, QueuedMessage[]>;

  // 存入消息
  enqueue(sessionToken: string, message: string, openId: string): void;

  // 取出所有待处理消息（并清空队列）
  dequeue(sessionToken: string): QueuedMessage[];

  // 检查是否有待处理消息
  hasPending(sessionToken: string): boolean;

  // 获取所有有待处理消息的 session token
  getSessionsWithPending(): string[];
}

interface QueuedMessage {
  text: string;
  openId: string;
  receivedAt: number;
}
```

#### MessageInjector（空闲消息注入器）

Bridge 内置后台进程，处理 CC 空闲状态下的消息注入：

```typescript
class MessageInjector {
  private readonly queue: MessageQueue;
  private readonly router: SessionRouter;
  private readonly logger;
  private intervalHandle: NodeJS.Timeout | null;

  // 启动轮询（默认 3 秒间隔）
  start(intervalMs?: number): void;

  // 停止轮询
  stop(): void;

  // 检查 CC 是否空闲（最近 5 秒无 Hook 活动）
  private isSessionIdle(sessionToken: string): boolean;

  // 通过终端机制注入消息
  private injectToTerminal(sessionToken: string, message: string): Promise<void>;

  // macOS: osascript 注入
  private injectViaOsascript(text: string): Promise<void>;

  // Linux: tmux send-keys 注入
  private injectViaTmux(session: string, pane: string, text: string): Promise<void>;
}
```

终端注入机制依赖注册时收集的信息：

| 平台 | 注入方式 | 要求 |
|------|---------|------|
| macOS (Terminal.app) | `osascript -e 'tell app "System Events" to keystroke "..."'` | 辅助功能权限 |
| macOS (iTerm2) | 同上 | 辅助功能权限 |
| Linux (tmux) | `tmux send-keys -t session:pane "..." Enter` | tmux 会话 |
| Linux (其他) | `xdotool type --clearmodifiers "..."` | xdotool 安装 |
| VS Code | 暂不支持终端注入 | 仅 Stop Hook 方式 |

### 技术选型

| 组件 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js >= 18 | 跨平台支持，LTS 版本 |
| 飞书 SDK | `@larksuiteoapi/node-sdk` | 长连接 WebSocket 模式，无需公网 |
| CLI 框架 | `commander` | 轻量 CLI 命令管理 |
| 进程管理 | `node-daemon` + pidfile | 跨平台后台运行 |
| HTTP 服务器 | Node.js 内置 `http` | hooks 回调端点，零依赖 |
| 日志 | `pino` | 轻量结构化日志 |

### 目录结构

```
claude-code-remote/
├── package.json
├── bin/
│   └── claude-remote.js          # CLI 入口
├── src/
│   ├── bridge/
│   │   ├── server.ts             # HTTP 服务器（hooks 端点）
│   │   ├── feishu-client.ts      # 飞书长连接客户端
│   │   ├── router.ts             # 会话路由（token → CC 实例）
│   │   ├── approval.ts           # 审批队列管理
│   │   ├── message-queue.ts      # 消息队列（飞书 → CC 待注入消息）
│   │   ├── message-injector.ts   # 空闲消息注入器（osascript/tmux）
│   │   └── entry.ts              # Bridge 主入口，组装各组件
│   ├── cli/
│   │   ├── start.ts              # claude-remote start
│   │   ├── stop.ts               # claude-remote stop
│   │   ├── status.ts             # claude-remote status
│   │   └── init.ts               # claude-remote init
│   ├── skill/
│   │   └── remote.md             # /remote skill 定义文件
│   ├── hooks/
│   │   ├── hook-handler.ts       # Hook 事件处理器
│   │   └── hook-installer.ts     # 自动配置 settings.json hooks
│   └── utils/
│       ├── config.ts             # 配置管理
│       ├── auth.ts               # Token 生成与验证
│       └── platform.ts           # 跨平台适配（Linux/Mac/Windows）
├── templates/
│   └── settings-hooks.json       # hooks 配置模板
└── README.md
```

## 实现要点

1. **Hook 事件覆盖**：Claude Code hooks 能捕获的事件类型有限，需确认 `PreToolUse`、`PostToolUse`、`Notification` 是否足以覆盖所有需要推送的内容。如果 CC 的文本输出（非工具调用）没有对应 hook，需要探索替代方案（如监听 CC 的输出文件）。

2. **飞书长连接稳定性**：飞书 SDK 长连接模式可能因网络波动断开，需要实现自动重连机制和心跳检测。

3. **跨平台进程管理**：Linux/macOS 使用 `fork` + `setsid` 实现守护进程，Windows 需使用不同方案（如 `node-windows` 或直接前台运行 + 用户自行配置服务）。

4. **审批请求的实时性**：CC 的 hooks 是同步阻塞的（审批等待用户响应），飞书消息的来回延迟可能影响 CC 体验。需要确保 bridge 的审批响应足够快，或考虑超时机制。

5. **CC 输入注入（已解决）**：采用双机制方案：
   - **工作中**：利用 CC 的 `Stop` Hook，在 agent 考虑停止时检查消息队列，返回 `decision: "block"` 注入飞书消息，让 agent 继续执行新指令
   - **空闲中**：Bridge 内置 MessageInjector 后台进程，3 秒间隔轮询消息队列，检测到 CC 空闲时通过 `osascript`（macOS）或 `tmux send-keys`（Linux）向终端注入文本
   - 两种机制自动切换：通过最近 Hook 活动时间判断 CC 状态（5 秒阈值）
   - **VS Code 限制**：VS Code 中的 CC 实例不支持终端注入，仅能通过 Stop Hook 接收消息

6. **终端注入权限**：macOS 的 `osascript` 需要辅助功能权限，tmux 注入需要 CC 运行在 tmux 会话中。注册时应检测环境并提示用户。

7. **消息注入可靠性**：多条消息同时到达时，Stop Hook 会一次性合并返回；MessageInjector 按队列顺序逐条注入，每条间隔 500ms。

## 约束一致性

`spec/global/` 目录不存在，本章节省略。

## 验收标准

- [ ] NPM 全局安装后 `claude-remote init` 可完成飞书配置
- [ ] `claude-remote start` 启动 bridge 进程，飞书 Bot 上线
- [ ] CC 中 `/remote` 成功注册实例，飞书收到上线通知
- [ ] CC 输出内容实时推送到飞书（文本、工具结果）
- [ ] 飞书中发送文本，CC 收到并执行
- [ ] 审批请求推送到飞书，用户点击按钮后 CC 收到响应
- [ ] 支持动态多选审批（选项数量和内容可变）
- [ ] 飞书中发送 `/` 命令，CC 正确执行
- [ ] 支持 Linux / macOS / Windows 三平台运行
- [ ] 多实例场景下消息正确路由，互不干扰
- [ ] 未授权用户消息被拒绝
- [ ] Token 认证有效，非法请求被拦截
- [ ] Bridge 断线后自动重连
- [ ] CC 进程退出后 bridge 自动清理注册信息
- [ ] **CC 工作中**：飞书发送文本 → Stop Hook 触发 → CC 继续执行新指令
- [ ] **CC 空闲中**：飞书发送文本 → MessageInjector 注入终端 → CC 接收并处理
- [ ] **多消息合并**：多条飞书消息同时到达时，Stop Hook 一次性合并返回
- [ ] **注入失败降级**：终端注入失败时，消息保留在队列中等待 Stop Hook 触发
