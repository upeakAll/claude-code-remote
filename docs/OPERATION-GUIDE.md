# Claude Code Remote 操作手册

本文档面向最终用户，详细说明如何使用飞书 Bot 远程控制 Claude Code。

---

## 目录

1. [首次部署](#1-首次部署)
2. [日常使用流程](#2-日常使用流程)
3. [飞书端操作](#3-飞书端操作)
4. [远程指令发送](#4-远程指令发送)
5. [工具审批](#5-工具审批)
6. [常见场景](#6-常见场景)
7. [故障排查](#7-故障排查)
8. [配置参考](#8-配置参考)

---

## 1. 首次部署

### 1.1 安装 tmux

tmux 是远程控制的前提条件，支持熄屏/锁屏状态下收发消息。

```bash
brew install tmux        # macOS
sudo apt install tmux    # Ubuntu/Debian
sudo yum install tmux    # CentOS/RHEL
```

### 1.2 安装项目

```bash
cd claude-code-remote
npm install
npm run build
```

### 1.3 飞书应用创建

1. 登录 [飞书开发者后台](https://open.feishu.cn/app)
2. 点击「创建企业自建应用」
3. 记录 **App ID** 和 **App Secret**

### 1.4 开通机器人能力

在应用管理页 → 「添加应用能力」→ 开通「机器人」。

### 1.5 配置事件订阅

在「事件与回调」页面：

1. 订阅方式选择 **「使用长连接接收回调」**
2. 添加事件订阅：**接收消息 (im.message.receive_v1)**
3. 添加回调订阅：**卡片回传交互 (card.action.trigger)**

### 1.6 获取用户 open_id

在飞书开发者后台 → 「调试工具」→ 使用「获取用户信息」接口获取你的 `open_id`（格式：`ou_xxxxxxxxxxxxxxxx`）。

### 1.7 初始化配置

```bash
claude-remote init
```

按提示输入：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| Feishu App ID | 步骤 1.3 中获取的 App ID | `cli_xxxxxxxxxxxx` |
| Feishu App Secret | 步骤 1.3 中获取的 App Secret | `xxxxxxxxxxxxxxxxxxxxxx` |
| Server port | Bridge HTTP 监听端口 | `9876`（默认） |
| Allowed users | 允许使用的飞书用户 open_id | `ou_xxxxxxxxxxxxxxxx` |

### 1.8 发布应用

在飞书开发者后台点击「创建版本」→「申请发布」，管理员审批通过后即可使用。

---

## 2. 日常使用流程

每次使用只需三步：

```
启动 Bridge → tmux 内启动 CC 并连接 → 飞书控制
```

### 2.1 启动 Bridge 服务

```bash
claude-remote start
```

输出示例：
```
Bridge started (PID: 12345)
  Server: http://127.0.0.1:9876
  Log file: ~/.claude-remote/logs/bridge.log
```

> Bridge 服务只需启动一次，多个 CC 会话可共用同一个 Bridge。

### 2.2 在 tmux 中启动 CC 并连接

```bash
# 创建 tmux 会话
tmux new -s claude

# 在 tmux 中启动 Claude Code
claude

# 在 CC 中连接远程
/remote
```

成功输出：
```
Remote session registered.
Session ID: a1b2c3d4e5f6g7h8
Token: 78d51822...
Hooks installed in .claude/settings.json
```

> **注意**：`/remote` 只在 tmux 环境中可用。非 tmux 环境会被拒绝注册。

### 2.3 在飞书中绑定

1. 打开飞书，找到 Bot 对话
2. 发送 `/list` 查看可用会话
3. 发送 `/bind <session_id>` 绑定到目标会话

绑定成功后即可开始远程控制。

---

## 3. 飞书端操作

### 3.1 命令一览

| 命令 | 用途 | 示例 |
|------|------|------|
| `/list` | 查看所有在线 CC 实例 | `/list` |
| `/bind <session_id>` | 绑定到指定实例 | `/bind a1b2c3d4e5f6g7h8` |
| `/unbind` | 断开连接并注销会话 | `/unbind` |
| `/status` | 查看当前绑定状态 | `/status` |
| *(任意文本)* | 发送到 CC 实例 | `帮我重构一下 auth 模块` |

### 3.2 绑定会话

飞书中发送 `/list`，Bot 会返回在线会话列表及绑定按钮：

```
2 online session(s):

• a1b2c3d4e5f6g7h8 - /path/to/project (since 2026/4/4 10:00:00)
  [Bind: a1b2c3d4e5f6g7h8]

• b1c2d3e4f5g6h7i8 - /path/to/other (since 2026/4/4 10:05:00)
  [Bind: b1c2d3e4f5g6h7i8]
```

点击「Bind」按钮或发送 `/bind <session_id>` 完成绑定。

### 3.3 查看绑定状态

```
/status
```

Bot 回复：
```
Bound session: a1b2c3d4e5f6g7h8
State: online
```

### 3.4 断开连接

```
/unbind
```

Bot 回复：
```
已断开会话: a1b2c3d4e5f6g7h8 (/path/to/project)
```

> 断开只能通过飞书 `/unbind` 发起。CC 端无法主动断开连接。

---

## 4. 远程指令发送

这是核心功能：从飞书向正在运行的 CC 会话发送指令。

### 4.1 工作原理

飞书消息通过两条路径送达 CC：

**路径 A：Stop Hook 消费（主路径）**
```
飞书发消息 → 消息入队 → CC 即将停止时 Stop Hook 触发 →
检测到队列有消息 → block CC 停止 → 消息注入 CC → CC 继续处理
```

**路径 B：空闲注入（补充路径）**
```
飞书发消息 → 消息入队 → CC 空闲超过 5 秒 →
MessageInjector 通过 tmux send-keys 注入 → 消息进入 CC 输入
```

两条路径都支持熄屏/锁屏状态（因为使用 tmux send-keys）。

### 4.2 使用方式

在飞书中直接输入文字即可：

```
帮我检查一下最近的 git log
```

```
分析一下 src/auth.ts 的安全性
```

```
运行测试看看有没有问题
```

### 4.3 多条消息

连续发送多条消息时，消息会依次排队。Stop Hook 触发时会一次性出队所有消息：

```
[1] 第一条消息
[2] 第二条消息
```

---

## 5. 工具审批

当 CC 需要执行工具时（如 Bash 命令、文件写入等），Bridge 会拦截并向飞书发送审批卡片。

### 5.1 审批卡片

飞书中会收到一张交互卡片：

```
┌──────────────────────────────────┐
│  ⚠️ 工具审批: PreToolUse         │
│──────────────────────────────────│
│  🔧 Bash 命令                    │
│                                  │
│  > 检查项目依赖                  │
│                                  │
│  ```bash                         │
│  npm run test -- --coverage      │
│  ```                             │
│──────────────────────────────────│
│  [ ✅ 允许 ]   [ ❌ 拒绝 ]        │
└──────────────────────────────────┘
```

不同工具类型的卡片展示：

| 工具 | 卡片内容 |
|------|---------|
| **Bash** | 命令内容 + 描述 |
| **Write** | 文件路径 + 内容预览 |
| **Edit** | 文件路径 + 替换前/后对比 |
| **Read** | 文件路径 + offset/limit |
| **WebSearch/WebFetch** | URL 或查询关键词 |
| **其他** | JSON 格式的工具输入 |

### 5.2 操作方式

- 点击 **「允许」**：CC 继续执行该工具
- 点击 **「拒绝」**：CC 取消执行，收到拒绝原因
- Bot 回复 `✅ 已允许` 或 `❌ 已拒绝` 确认操作

### 5.3 超时处理

审批请求 5 分钟内未响应则自动拒绝，防止 CC 永久阻塞。

---

## 6. 常见场景

### 场景 A：出门前启动长时间任务

```
1. 在 tmux 中启动 CC，运行 /remote 连接
2. 在飞书中 /bind 绑定
3. 让 CC 开始工作（如运行测试、重构代码等）
4. 出门，手机上通过飞书监控进度
5. 飞书收到 Notification → 查看进展
6. 飞书收到审批请求 → 点击允许/拒绝
7. 飞书发新指令 → CC 继续处理
```

> 即使电脑熄屏或锁屏，tmux send-keys 仍能正常工作，消息不会被遗漏。

### 场景 B：手机上临时给 CC 新任务

```
飞书发消息：帮我看看 logs 目录下今天的错误日志
→ CC 收到指令，开始分析
→ 飞书收到工具调用审批（如需读取文件）→ 点击允许
→ 飞书收到 PostToolUse 结果卡片
→ 飞书收到 Stop Hook 转发的 CC 回复
```

### 场景 C：多项目并行

```
tmux 会话 1：project-a（Session: aaa111）
tmux 会话 2：project-b（Session: bbb222）

飞书发 /list → 看到两个实例
飞书发 /bind aaa111 → 操作项目 A
飞书发 /bind bbb222 → 切换到项目 B
```

---

## 7. 故障排查

### 7.1 Bridge 无法启动

**症状：** `Bridge is already running` 或端口被占用

```bash
# 查看占用端口的进程
lsof -i :9876

# 强制停止
claude-remote stop

# 检查残留 PID 文件
ls ~/.claude-remote/bridge.pid
rm ~/.claude-remote/bridge.pid  # 如有残留
```

### 7.2 CC 连接失败

**症状：** `/remote` 报 Bridge 不可达

1. 确认 Bridge 正在运行：`claude-remote status`
2. 确认端口可达：`curl -s http://127.0.0.1:9876/status`
3. 如果没运行：`claude-remote start`

### 7.3 /remote 提示需要 tmux

**症状：** `⚠️ 远程控制需要 CC 在 tmux 中运行`

```bash
# 先安装 tmux
brew install tmux

# 创建 tmux 会话
tmux new -s claude

# 在 tmux 中重新启动 CC
claude

# 再次运行 /remote
```

### 7.4 飞书收不到消息

**症状：** CC 正常运行但飞书无推送

1. 确认飞书绑定：在飞书中发 `/status`
2. 检查 Bridge 日志：`claude-remote log -n 50`
3. 确认飞书应用已发布且已审批
4. 确认用户 open_id 在白名单中

### 7.5 消息发送到 CC 无效

**症状：** 飞书发消息但 CC 没反应

1. 确认已绑定正确的会话：`/status`
2. 检查 CC 会话是否在线：`/list`
3. 查看日志中是否有 `Message enqueued` 或 `tmux send-keys` 记录
4. 确认 CC 确实在 tmux 中运行：`echo $TMUX`

### 7.6 审批卡片无法点击

**症状：** 卡片按钮无响应

1. 确认飞书应用已配置「卡片回传交互」回调
2. 检查日志：`claude-remote log | grep card`
3. 此问题可能需要 monkey-patch WSClient 处理

### 7.7 会话自动断开

**症状：** 之前绑定的会话消失了

1. Bridge 重启会清空所有会话（内存存储），需重新 `/remote`
2. 检查 Bridge 是否意外停止：`claude-remote status`
3. 正常使用中会话不会自动超时断开（已移除自动清理）

### 7.8 查看日志

```bash
# 查看最近 50 行日志
claude-remote log -n 50

# 实时追踪日志
claude-remote log -f

# 查看完整日志文件
cat ~/.claude-remote/logs/bridge.log
```

---

## 8. 配置参考

### 8.1 文件路径

| 文件 | 路径 | 说明 |
|------|------|------|
| 主配置 | `~/.claude-remote/config.json` | Bridge 全局配置 |
| 日志 | `~/.claude-remote/logs/bridge.log` | Bridge 运行日志 |
| PID 文件 | `~/.claude-remote/bridge.pid` | Bridge 进程 PID |
| Token 文件 | `{project}/.claude/remote-token` | 当前项目的远程 Token |
| Hook 配置 | `{project}/.claude/settings.json` | CC Hook 配置 |

### 8.2 config.json 完整字段

```json
{
  "feishu": {
    "appId": "cli_xxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "server": {
    "port": 9876,
    "host": "127.0.0.1"
  },
  "allowedUsers": ["ou_xxxxxxxxxxxxxxxx"],
  "heartbeatInterval": 30000,
  "sessionTimeout": 300000
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `feishu.appId` | string | - | 飞书应用 App ID |
| `feishu.appSecret` | string | - | 飞书应用 App Secret |
| `server.port` | number | 9876 | Bridge HTTP 端口 |
| `server.host` | string | 127.0.0.1 | Bridge 监听地址 |
| `allowedUsers` | string[] | [] | 允许的飞书用户 open_id |
| `heartbeatInterval` | number | 30000 | 心跳检测间隔（ms，仅用于状态报告） |
| `sessionTimeout` | number | 300000 | 保留字段，不再用于自动清理 |

### 8.3 Hook 类型说明

| Hook 类型 | 触发时机 | Bridge 行为 |
|-----------|---------|-------------|
| `PreToolUse` | CC 执行工具前 | 拦截 → 发送审批卡片到飞书 → 等待用户操作 → 返回允许/拒绝 |
| `PostToolUse` | CC 执行工具后 | 转发工具结果到飞书 |
| `Notification` | CC 发出通知 | 转发通知内容到飞书 |
| `Stop` | CC 即将停止 | 转发 CC 回复 + 检查消息队列，有消息则阻止停止 |

### 8.4 断开机制说明

| 操作 | 谁可以触发 | 说明 |
|------|-----------|------|
| 飞书 `/unbind` | 飞书用户 | 唯一断开方式，注销会话并清理 |
| CC `/remote off` | 已禁用 | CC 端无法主动断开 |
| 自动超时 | 已禁用 | 会话不会自动断开 |
| Bridge 重启 | 间接 | 所有会话丢失（内存存储），需重新注册 |
