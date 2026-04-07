---
name: remote
description: 进入飞书远程控制模式，通过手机飞书 App 控制当前 Claude Code 会话
user-invocable: true
---

Control the current Claude Code session remotely via Feishu bot. This command registers or checks the status of a remote control session through a local Bridge server.

Usage: `/remote` or `/remote on` to connect, `/remote status` to check. Disconnecting is only available via Feishu `/unbind` command — CC side cannot disconnect.

---

## 连接注册（on）- `/remote` or `/remote on`

### 步骤 1：检查 claude-remote 是否已安装

Execute:
```
which claude-remote 2>/dev/null && claude-remote --version
```

If the command is not found (no output), tell the user:
```
⚠️ claude-remote 未安装。需要全局安装后才能使用远程控制功能。

安装命令：
  npm install -g claude-code-remote

安装完成后请再次运行 /remote。
```
Stop here and wait for the user to install.

### 步骤 2：检查 Bridge 服务是否运行

Execute:
```
claude-remote status
```

If the output shows Bridge is NOT running (process not found or status check failed), ask the user:
```
Bridge 服务未启动。是否现在启动？

启动命令：claude-remote start
```

Wait for user confirmation, then execute:
```
claude-remote start
```

Verify it started successfully. If startup fails (e.g., missing Feishu config), tell the user to run `claude-remote init` first to configure Feishu credentials, then stop here.

### 步骤 3：检查 tmux 环境

Execute:
```
echo $TMUX
```

If the output is empty (not in tmux), tell the user:
```
⚠️ 远程控制需要 CC 在 tmux 中运行（支持熄屏/锁屏状态下接收飞书消息）。
请先安装 tmux（brew install tmux），然后：
  1. tmux new -s claude
  2. 在 tmux 会话内重新启动 claude
  3. 再次运行 /remote
```
Stop here.

### 步骤 4：注册会话

Execute:
```
claude-remote register
```

This single command will automatically:
- Generate session ID
- Register session with Bridge
- Save token file to `.claude/remote-token`
- Merge hooks into `.claude/settings.json`

### 步骤 5：报告结果

On success, report the output to the user. Remind the user to bind the session from Feishu:
```
在飞书中找到 Bot 对话，发送 /list 查看会话，然后 /bind <session_id> 绑定。
```

---

## 断开连接（disabled）

`/remote off` 已禁用。会话断开只能由飞书用户发起。

飞书用户发送 `/unbind` 即可断开与当前绑定会话的连接。断开后 Bridge 会自动清理该会话的注册信息和 hooks 配置。

---

## 查看状态（status）- `/remote status`

Check whether the current project is connected to a remote session and display session info.

1. Run `pwd` to determine the current working directory. Save as `WORKDIR`.
2. Execute:
   ```
   claude-remote remote-status
   ```
   This command will check token file, Bridge server status, and hooks installation.
3. Report the output to the user.
