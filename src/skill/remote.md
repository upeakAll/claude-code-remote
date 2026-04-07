---
name: remote
description: 进入飞书远程控制模式，通过手机飞书 App 控制当前 Claude Code 会话
user-invocable: true
---

Control the current Claude Code session remotely via Feishu bot. This command registers or checks the status of a remote control session through a local Bridge server.

Usage: `/remote` or `/remote on` to connect, `/remote status` to check. Disconnecting is only available via Feishu `/unbind` command — CC side cannot disconnect.

---

## 连接注册（on）- `/remote` or `/remote on`

Register the current working directory with the Bridge server and install hooks. This is done in one step using the `claude-remote register` command.

1. Run `pwd` to determine the current working directory. Save as `WORKDIR`.
2. Execute:
   ```
   claude-remote register
   ```
   This single command will automatically:
   - Check Bridge server is running
   - Verify tmux environment (reject if not in tmux)
   - Generate session ID
   - Register session with Bridge
   - Save token file to `.claude/remote-token`
   - Merge hooks into `.claude/settings.json`
3. If the command reports "not in tmux" error, tell the user:
   ```
   ⚠️ 远程控制需要 CC 在 tmux 中运行（支持熄屏/锁屏状态下接收飞书消息）。
   请先安装 tmux（brew install tmux），然后：
     1. tmux new -s claude
     2. 在 tmux 会话内重新启动 claude
     3. 再次运行 /remote
   ```
4. If the command reports Bridge not running, tell the user to start it first with `claude-remote start`.
5. On success, report the output to the user.

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
