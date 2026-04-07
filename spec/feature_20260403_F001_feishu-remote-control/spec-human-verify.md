# 飞书远程控制（增量）人工验收清单

**生成时间:** 2026-04-04
**关联计划:** spec/feature_20260403_F001_feishu-remote-control/spec-plan.md
**关联设计:** spec/feature_20260403_F001_feishu-remote-control/spec-design.md

---

## 验收前准备

### 环境要求
- [ ] [AUTO] 验证 Node.js 版本: `node --version`
- [ ] [AUTO] 安装依赖并编译: `npm install && npm run build`
- [ ] [AUTO/SERVICE] 启动 Bridge 服务: `claude-remote start` (port: 9876)
- [ ] [MANUAL] 确认 `~/.claude-remote/config.json` 已配置有效飞书 App ID/Secret
- [ ] [MANUAL] 确认 CC 运行在 tmux 会话或 macOS Terminal.app 中

### 测试数据准备
- [ ] 飞书测试账号在 allowedUsers 白名单中
- [ ] 飞书测试账号已与 Bot 建立会话

---

## 验收项目

### 场景 1: 构建与测试基线

#### - [x] 1.1 TypeScript 编译无错误
- **来源:** spec-plan.md Task 0/6 检查步骤
- **目的:** 确认代码类型安全无误
- **操作步骤:**
  1. [A] `npx tsc --noEmit 2>&1 | grep -c error` → 期望精确: 0

#### - [x] 1.2 完整测试套件通过
- **来源:** spec-plan.md Task 6 端到端验证 §1
- **目的:** 确认所有单元测试绿色
- **操作步骤:**
  1. [A] `npx vitest run 2>&1 | tail -10` → 期望包含: Tests (无 FAIL)

#### - [x] 1.3 新增文件结构完整
- **来源:** spec-plan.md Task 6 端到端验证 §3
- **目的:** 确认 Task 1/5 新增文件存在
- **操作步骤:**
  1. [A] `ls src/bridge/message-queue.ts src/bridge/message-injector.ts src/__tests__/message-queue.test.ts src/__tests__/message-injector.test.ts 2>&1` → 期望包含: message-queue.ts (无 No such file)

---

### 场景 2: 消息队列模块

#### - [x] 2.1 MessageQueue 导出与接口完整
- **来源:** spec-plan.md Task 1 检查步骤
- **目的:** 确认消息队列模块结构正确
- **操作步骤:**
  1. [A] `grep -c 'export' src/bridge/message-queue.ts` → 期望包含: (≥2)
  2. [A] `grep -E '^\s+(enqueue|dequeue|hasPending|getSessionsWithPending|destroy)\(' src/bridge/message-queue.ts | wc -l` → 期望精确: 5

#### - [x] 2.2 消息队列单元测试通过
- **来源:** spec-plan.md Task 1 检查步骤 / spec-design.md §MessageQueue
- **目的:** 确认消息队列功能正确（含边界：多 session、部分消费、destroy）
- **操作步骤:**
  1. [A] `npx vitest run src/__tests__/message-queue.test.ts 2>&1 | tail -5` → 期望包含: Tests (无 FAIL)

---

### 场景 3: Stop Hook 类型全链路

#### - [x] 3.1 Stop 类型存在于三个源文件
- **来源:** spec-plan.md Task 2 检查步骤
- **目的:** 确认 Stop Hook 类型全链路贯通
- **操作步骤:**
  1. [A] `grep -n "'Stop'" src/hooks/hook-handler.ts src/bridge/server.ts src/hooks/hook-installer.ts` → 期望包含: hook-handler.ts, server.ts, hook-installer.ts

#### - [x] 3.2 Hooks 模板包含 Stop 条目
- **来源:** spec-plan.md Task 2 检查步骤
- **目的:** 确认模板安装 Stop Hook 条目
- **操作步骤:**
  1. [A] `grep -c '"Stop"' templates/settings-hooks.json` → 期望精确: 1

#### - [x] 3.3 Stop Hook 相关单元测试通过
- **来源:** spec-plan.md Task 2 检查步骤 / spec-design.md §Stop Hook
- **目的:** 确认 Stop Hook 处理逻辑正确（含边界：无 token/无效 token 拒绝）
- **操作步骤:**
  1. [A] `npx vitest run src/__tests__/hook-handler.test.ts src/__tests__/server.test.ts src/__tests__/hook-installer.test.ts 2>&1 | tail -10` → 期望包含: Tests (无 FAIL)

---

### 场景 4: 飞书消息转发与 Stop Hook 消费集成

#### - [x] 4.1 组件集成 MessageQueue 正确
- **来源:** spec-plan.md Task 3 检查步骤
- **目的:** 确认消息入队与消费链路贯通
- **操作步骤:**
  1. [A] `grep -n 'messageQueue' src/bridge/feishu-client.ts | head -5` → 期望包含: enqueue
  2. [A] `grep -n 'hasPending\|dequeue' src/hooks/hook-handler.ts` → 期望包含: hasPending, dequeue
  3. [A] `grep -n 'decision' src/bridge/server.ts` → 期望包含: approve, block

#### - [x] 4.2 Entry 组件组装完整
- **来源:** spec-plan.md Task 3 检查步骤
- **目的:** 确认 MessageQueue 在 Bridge 中正确创建和传递
- **操作步骤:**
  1. [A] `grep -n 'MessageQueue\|messageQueue' src/bridge/entry.ts` → 期望包含: import, new MessageQueue, destroy

#### - [x] 4.3 消息转发集成单元测试通过
- **来源:** spec-plan.md Task 3 检查步骤 / spec-design.md §消息流设计
- **目的:** 确认飞书消息入队与 Stop Hook 消费功能正确（含边界：多消息合并、dequeue 后清空）
- **操作步骤:**
  1. [A] `npx vitest run src/__tests__/feishu-client.test.ts src/__tests__/hook-handler.test.ts src/__tests__/server.test.ts 2>&1 | tail -10` → 期望包含: Tests (无 FAIL)

---

### 场景 5: 终端信息收集

#### - [x] 5.1 TerminalInfo 接口与路由层
- **来源:** spec-plan.md Task 4 检查步骤 / spec-design.md §/remote Skill
- **目的:** 确认终端信息数据模型和路由支持
- **操作步骤:**
  1. [A] `grep -n 'export interface TerminalInfo' src/bridge/router.ts` → 期望包含: TerminalInfo
  2. [A] `grep -n 'terminal' src/bridge/router.ts | wc -l` → 期望包含: (≥3)

#### - [x] 5.2 服务层与 Skill 终端检测
- **来源:** spec-plan.md Task 4 检查步骤
- **目的:** 确认服务端解析和 Skill 终端环境检测
- **操作步骤:**
  1. [A] `grep -n 'terminal' src/bridge/server.ts | wc -l` → 期望包含: (≥4)
  2. [A] `grep -c 'TMUX' src/skill/remote.md` → 期望包含: (≥2)
  3. [A] `grep -c 'terminal' src/skill/remote.md` → 期望包含: (≥2)

#### - [x] 5.3 终端信息单元测试通过
- **来源:** spec-plan.md Task 4 检查步骤
- **目的:** 确认终端信息收集功能正确（含边界：无效 terminal type 忽略、vscode 支持）
- **操作步骤:**
  1. [A] `npx vitest run src/__tests__/router.test.ts src/__tests__/server.test.ts src/__tests__/skill.test.ts 2>&1 | tail -10` → 期望包含: Tests (无 FAIL)

---

### 场景 6: 空闲消息注入器

#### - [x] 6.1 MessageInjector 类完整
- **来源:** spec-plan.md Task 5 检查步骤 / spec-design.md §MessageInjector
- **目的:** 确认注入器类导出且核心方法完整
- **操作步骤:**
  1. [A] `grep -c 'export class MessageInjector' src/bridge/message-injector.ts` → 期望精确: 1
  2. [A] `grep -E '^\s+(start|stop|private tick|private isSessionIdle|private async injectToTerminal|private async injectViaTmux|private async injectViaOsascript|private escapeForOsascript)\(' src/bridge/message-injector.ts | wc -l` → 期望精确: 8

#### - [x] 6.2 Entry 生命周期管理
- **来源:** spec-plan.md Task 5 检查步骤
- **目的:** 确认 Bridge 启停时管理注入器生命周期
- **操作步骤:**
  1. [A] `grep -n 'MessageInjector\|injector' src/bridge/entry.ts` → 期望包含: import, start, stop

#### - [x] 6.3 注入器单元测试通过
- **来源:** spec-plan.md Task 5 检查步骤 / spec-design.md §MessageInjector
- **目的:** 确认空闲消息注入逻辑正确（含边界：不支持的终端类型跳过、注入失败不中断、无 terminal 跳过）
- **操作步骤:**
  1. [A] `npx vitest run src/__tests__/message-injector.test.ts 2>&1 | tail -10` → 期望包含: Tests (无 FAIL)

---

### 场景 7: 端到端功能验证

#### - [x] 7.1 Stop Hook 空消息返回 approve
- **来源:** spec-plan.md Task 6 端到端验证 §4
- **目的:** 确认无待处理消息时 CC 正常停止
- **操作步骤:**
  1. [A] `TOKEN=$(curl -s -X POST http://127.0.0.1:9876/register -H 'Content-Type: application/json' -d '{"session_id":"e2e-test","workdir":"/tmp/test","terminal":{"type":"terminal"}}' | jq -r .token) && curl -s -X POST http://127.0.0.1:9876/hook -H 'Content-Type: application/json' -H "X-Token: $TOKEN" -d '{"type":"Stop","session_id":"e2e-test","content":""}'` → 期望包含: "decision":"approve"

#### - [x] 7.2 消息队列端到端（飞书入队→Stop Hook 出队）
- **来源:** spec-plan.md Task 6 端到端验证 §5 / spec-design.md 验收标准
- **目的:** 确认飞书消息经队列由 Stop Hook 消费并返回 block
- **操作步骤:**
  1. [H] 在飞书 App 中向 Bot 发送文本消息"验收测试"，确认消息已送达 → 是/否
  2. [A] `curl -s -X POST http://127.0.0.1:9876/hook -H 'Content-Type: application/json' -H "X-Token: $TOKEN" -d '{"type":"Stop","session_id":"e2e-test","content":""}'` → 期望包含: "decision":"block"

#### - [x] 7.3 终端信息注册成功
- **来源:** spec-plan.md Task 6 端到端验证 §6
- **目的:** 确认注册时收集终端信息
- **操作步骤:**
  1. [A] `curl -s -X POST http://127.0.0.1:9876/register -H 'Content-Type: application/json' -d '{"session_id":"term-test","workdir":"/tmp","terminal":{"type":"tmux","tmuxSession":"0","tmuxPane":"0"}}'` → 期望包含: token

#### - [x] 7.4 Hooks 模板包含 Stop 类型
- **来源:** spec-plan.md Task 6 端到端验证 §7
- **目的:** 确认 hooks 模板覆盖 Stop 事件
- **操作步骤:**
  1. [A] `cat templates/settings-hooks.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(list(d['hooks'].keys()))"` → 期望包含: Stop

#### - [x] 7.5 注入器生命周期确认
- **来源:** spec-plan.md Task 6 端到端验证 §8
- **目的:** 确认 Bridge 启动时 MessageInjector 自动运行
- **操作步骤:**
  1. [A] `claude-remote log 2>&1 | grep -i 'messageinjector'` → 期望包含: started

---

## 验收后清理

- [ ] [AUTO] 终止 Bridge 后台服务: `claude-remote stop` (对应准备阶段启动的 Bridge 服务)

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | TypeScript 编译无错误 | 1 | 0 | ✅ |
| 场景 1 | 1.2 | 完整测试套件通过 | 1 | 0 | ✅ |
| 场景 1 | 1.3 | 新增文件结构完整 | 1 | 0 | ✅ |
| 场景 2 | 2.1 | MessageQueue 导出与接口完整 | 2 | 0 | ✅ |
| 场景 2 | 2.2 | 消息队列单元测试通过 | 1 | 0 | ✅ |
| 场景 3 | 3.1 | Stop 类型存在于三个源文件 | 1 | 0 | ✅ |
| 场景 3 | 3.2 | Hooks 模板包含 Stop 条目 | 1 | 0 | ✅ |
| 场景 3 | 3.3 | Stop Hook 相关单元测试通过 | 1 | 0 | ✅ |
| 场景 4 | 4.1 | 组件集成 MessageQueue 正确 | 3 | 0 | ✅ |
| 场景 4 | 4.2 | Entry 组件组装完整 | 1 | 0 | ✅ |
| 场景 4 | 4.3 | 消息转发集成单元测试通过 | 1 | 0 | ✅ |
| 场景 5 | 5.1 | TerminalInfo 接口与路由层 | 2 | 0 | ✅ |
| 场景 5 | 5.2 | 服务层与 Skill 终端检测 | 3 | 0 | ✅ |
| 场景 5 | 5.3 | 终端信息单元测试通过 | 1 | 0 | ✅ |
| 场景 6 | 6.1 | MessageInjector 类完整 | 2 | 0 | ✅ |
| 场景 6 | 6.2 | Entry 生命周期管理 | 1 | 0 | ✅ |
| 场景 6 | 6.3 | 注入器单元测试通过 | 1 | 0 | ✅ |
| 场景 7 | 7.1 | Stop Hook 空消息返回 approve | 1 | 0 | ✅ |
| 场景 7 | 7.2 | 消息队列端到端 | 1 | 1 | ✅ |
| 场景 7 | 7.3 | 终端信息注册成功 | 1 | 0 | ✅ |
| 场景 7 | 7.4 | Hooks 模板包含 Stop 类型 | 1 | 0 | ✅ |
| 场景 7 | 7.5 | 注入器生命周期确认 | 1 | 0 | ✅ |

**验收结论:** ✅ 全部通过 / ⬜ 存在问题
