# 飞书远程控制（增量）执行计划

**目标:** 补齐飞书远程控制功能中缺失的核心模块：消息队列、Stop Hook 双机制消息注入、终端信息收集与空闲消息注入器

**技术栈:** Node.js >= 18, TypeScript, @larksuiteoapi/node-sdk, commander, pino, vitest

**设计文档:** spec-design.md

## 改动总览

本次改动补齐飞书远程控制功能中的 5 个缺失模块，共涉及 **4 个新增文件 + 14 个修改文件**（去重后），按依赖链线性排列：

- **Task 1（消息队列）→ Task 2（Stop Hook 类型）→ Task 3（飞书消息转发与 Stop Hook 消费）→ Task 4（终端信息）→ Task 5（空闲注入器）**，前 3 个 Task 为核心消息链路，后 2 个为增强能力
- Task 1 创建 `MessageQueue` 数据结构，是 Task 3（飞书消息入队）和 Task 5（空闲注入器消费队列）的共同依赖
- Task 2 在全链路添加 Stop Hook 类型支持，为 Task 3 中 Stop Hook 消费消息队列提供类型基础
- Task 4 扩展注册接口收集终端信息，Task 5 的 `MessageInjector` 根据终端类型选择注入方式（tmux/osascript）
- 关键设计决策：采用双机制消息注入（Stop Hook 主通道 + MessageInjector 空闲注入），通过 `lastHeartbeat` 判断 CC 状态自动切换

---

### Task 0: 环境准备

**背景:**
验证增量开发所需的构建和测试工具链可用，确认现有代码库状态正常，避免后续 Task 因环境或已有代码问题阻塞。本 Task 是所有后续 Task 的前置条件，确保 TypeScript 编译、vitest 测试框架、现有测试套件均处于绿色状态。

**执行步骤:**
- [x] 验证项目依赖已安装且 TypeScript 编译无错误
  - 运行命令: `npm install && npx tsc --noEmit 2>&1 | tail -5`
  - 预期: 无 error 输出
- [x] 验证现有测试套件全部通过
  - 运行命令: `npx vitest run 2>&1 | tail -10`
  - 预期: 所有测试通过，无失败用例

**检查步骤:**
- [x] TypeScript 编译成功
  - `npx tsc --noEmit 2>&1 | grep -c error`
  - 预期: 输出 0
- [x] 测试套件绿色
  - `npx vitest run 2>&1 | grep -E 'Tests|FAIL'`
  - 预期: 无 FAIL，Tests 全部通过

---

### Task 1: 消息队列

**背景:**
飞书下发的指令需要暂存在 per-session 消息队列中，等待 Stop Hook 或 MessageInjector 消费。当前代码库中 `src/bridge/` 已有 `SessionRouter`（会话管理）、`ApprovalManager`（审批队列）等组件，但缺少消息队列实现。MessageQueue 是 Task 3（飞书消息转发与 Stop Hook 集成）和 Task 5（MessageInjector）的上游依赖，必须先完成。

**涉及文件:**
- 新建: `src/bridge/message-queue.ts`
- 新建: `src/__tests__/message-queue.test.ts`

**执行步骤:**
- [x] 创建 `src/bridge/message-queue.ts`，定义 `QueuedMessage` 接口和 `MessageQueue` 类
  - 位置: 新文件 `src/bridge/message-queue.ts`
  - 导出 `QueuedMessage` 接口:
    ```typescript
    export interface QueuedMessage {
      text: string;
      openId: string;
      receivedAt: number;
    }
    ```
  - 导出 `MessageQueue` 类，包含 `private queues: Map<string, QueuedMessage[]>`、`private readonly logger` 两个字段
  - 构造函数无参数，初始化 `queues` 为空 Map，`logger` 调用 `createLogger('message-queue')`
  - 原因: 遵循项目中 `router.ts`、`approval.ts` 的构造模式（logger 命名与模块对应）

- [x] 实现 `enqueue(sessionToken: string, message: string, openId: string): void` 方法
  - 位置: `MessageQueue.enqueue()`
  - 逻辑: 若 `queues` 中无该 sessionToken 对应数组则初始化空数组，然后 push `{ text: message, openId, receivedAt: Date.now() }`
  - 调用 `logger.info` 记录 `{ sessionToken: sessionToken.slice(0, 8), openId, textLength: message.length }`，日志消息为 `'Message enqueued'`
  - 原因: token 前缀脱敏与 `router.ts` 中 `unregister` 日志风格一致

- [x] 实现 `dequeue(sessionToken: string): QueuedMessage[]` 方法
  - 位置: `MessageQueue.dequeue()`
  - 逻辑: 从 `queues` 中取出该 sessionToken 对应的数组，调用 `queues.delete(sessionToken)` 清空该 session 队列，返回该数组；若不存在则返回空数组 `[]`
  - 调用 `logger.debug` 记录 `{ sessionToken: sessionToken.slice(0, 8), count: messages.length }`，日志消息为 `'Messages dequeued'`
  - 原因: dequeue 返回全部消息并清空，Stop Hook 一次性消费，与 spec-design.md 中"多消息合并"设计一致

- [x] 实现 `hasPending(sessionToken: string): boolean` 方法
  - 位置: `MessageQueue.hasPending()`
  - 逻辑: 返回 `queues.has(sessionToken) && queues.get(sessionToken)!.length > 0`

- [x] 实现 `getSessionsWithPending(): string[]` 方法
  - 位置: `MessageQueue.getSessionsWithPending()`
  - 逻辑: 遍历 `queues`，收集所有 value 数组 length > 0 对应的 key，返回 key 数组

- [x] 实现 `destroy(): void` 方法
  - 位置: `MessageQueue.destroy()`
  - 逻辑: 调用 `queues.clear()`
  - 原因: 与 `ApprovalManager.destroy()`、`SessionRouter.destroy()` 模式一致，支持 Bridge 关闭时清理资源

- [x] 为 `MessageQueue` 编写单元测试
  - 测试文件: `src/__tests__/message-queue.test.ts`
  - 测试场景:
    - `enqueue()` 单条消息: 向 session `tok-1` 入队一条消息 → `hasPending('tok-1')` 返回 `true`，`getSessionsWithPending()` 包含 `'tok-1'`
    - `enqueue()` 多条消息: 向同一 session 连续入队 3 条消息 → `dequeue()` 返回长度为 3 的数组，且 `receivedAt` 递增
    - `dequeue()` 返回并清空: 入队 2 条后 dequeue → 返回 2 条；再次 dequeue → 返回空数组
    - `dequeue()` 不存在的 session: `dequeue('nonexist')` → 返回 `[]`
    - `hasPending()` 无消息时: 新实例或 dequeue 后 → `hasPending('tok-1')` 返回 `false`
    - `getSessionsWithPending()` 多 session: 向 `tok-1` 和 `tok-2` 各入队 1 条 → 返回数组包含两个 token
    - `getSessionsWithPending()` 部分消费: 向 `tok-1` 入队 1 条，`tok-2` 入队 1 条，dequeue `tok-1` → 返回数组仅包含 `'tok-2'`
    - `QueuedMessage` 字段正确: 入队后 dequeue → 验证 `text`、`openId`、`receivedAt`（number 且 > 0）
    - `destroy()` 清空所有队列: 入队多条后 destroy → `getSessionsWithPending()` 返回空数组，`hasPending()` 全部为 `false`
  - 运行命令: `npx vitest run src/__tests__/message-queue.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 验证 `message-queue.ts` 导出正确
  - `grep -c 'export' src/bridge/message-queue.ts`
  - 预期: 输出 >= 2（`QueuedMessage` 接口 + `MessageQueue` 类）
- [x] 验证 `MessageQueue` 类包含全部公开方法
  - `grep -E '^\s+(enqueue|dequeue|hasPending|getSessionsWithPending|destroy)\(' src/bridge/message-queue.ts | wc -l`
  - 预期: 输出 5
- [x] 验证 TypeScript 编译无错误
  - `npx tsc --noEmit 2>&1 | tail -5`
  - 预期: 无 error 输出
- [x] 验证单元测试全部通过
  - `npx vitest run src/__tests__/message-queue.test.ts`
  - 预期: 所有测试用例通过，无失败

---

### Task 2: Stop Hook 类型支持

**背景:**
飞书远程控制的双机制消息注入方案中，"CC 工作中" 场景依赖 Claude Code 的 `Stop` Hook：当 CC agent 完成当前任务考虑停止时，Stop Hook 触发，Bridge 检查消息队列，若有待处理消息则返回 `{decision: "block"}` 让 agent 继续执行新指令，否则返回 `{decision: "approve"}` 让 CC 正常停止。当前代码库的 Hook 处理链（`HookHandler`、`BridgeServer.handleHook()`、`HookInstaller`、`settings-hooks.json` 模板）仅支持 `PreToolUse`、`PostToolUse`、`Notification` 三种类型，缺少 `Stop` 类型的完整支持。本 Task 补齐 `Stop` Hook 类型从模板到处理器的全链路基础设施，为 Task 3（Stop Hook 消费 MessageQueue）提供骨架。本 Task 不消费 MessageQueue——`handleStop()` 暂时返回固定 `{decision: "approve"}`。

**涉及文件:**
- 修改: `src/hooks/hook-handler.ts`
- 修改: `src/bridge/server.ts`
- 修改: `src/hooks/hook-installer.ts`
- 修改: `templates/settings-hooks.json`
- 修改: `src/__tests__/hook-handler.test.ts`
- 修改: `src/__tests__/hook-installer.test.ts`
- 修改: `src/__tests__/server.test.ts`

**执行步骤:**
- [x] 在 `HookPayload.type` 联合类型中添加 `'Stop'`
  - 位置: `src/hooks/hook-handler.ts` ~L10，`HookPayload` 接口的 `type` 字段
  - 将 `type: 'PreToolUse' | 'PostToolUse' | 'Notification'` 改为 `type: 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop'`
  - 原因: Stop 是 spec-design.md 定义的第四种 Hook 类型，HookPayload 是整个链路的类型定义起点

- [x] 扩展 `HookResult` 联合类型以支持 Stop Hook 响应格式
  - 位置: `src/hooks/hook-handler.ts` ~L18-21，`HookResult` 类型定义
  - 在现有联合类型末尾追加 `| { decision: 'approve' } | { decision: 'block'; reason: string; systemMessage: string }`
  - 修改后 `HookResult` 完整定义为:
    ```typescript
    export type HookResult =
      | { status: 'ok' }
      | { status: 'approval_pending'; request_id: string }
      | { status: 'error'; message: string }
      | { decision: 'approve' }
      | { decision: 'block'; reason: string; systemMessage: string };
    ```
  - 原因: Stop Hook 的响应格式与其他 Hook 不同——CC 期望收到 `decision` 字段而非 `status` 字段

- [x] 在 `HookHandler.handle()` 的 switch 中添加 `Stop` case
  - 位置: `src/hooks/hook-handler.ts` ~L43-52，`handle()` 方法的 switch 语句
  - 在 `case 'Notification':` 之后、`default:` 之前添加 `case 'Stop': return this.handleStop(sessionToken);`
  - 原因: 将 Stop 类型的请求路由到专用处理方法

- [x] 实现 `handleStop()` stub 方法
  - 位置: `src/hooks/hook-handler.ts`，在 `handleNotification()` 方法之后（~L113 之后）添加新方法
  - 方法签名: `private async handleStop(sessionToken: string): Promise<HookResult>`
  - Task 2 阶段固定返回 `{ decision: 'approve' }`
  - 添加 `logger.info('Stop hook received, approving (no-op stub)')` 日志
  - 原因: stub 实现，Task 3 将在此方法中消费 MessageQueue 并根据队列状态返回 block/approve

- [x] 在 `BridgeServer` 的 `HookPayload` 接口中添加 `'Stop'`
  - 位置: `src/bridge/server.ts` ~L12，`HookPayload` 接口的 `type` 字段
  - 将 `type: 'PreToolUse' | 'PostToolUse' | 'Notification'` 改为 `type: 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop'`
  - 原因: server.ts 有独立的本地 `HookPayload` 定义（与 hook-handler.ts 的不同），需同步更新

- [x] 在 `BridgeServer.handleHook()` 的 `validTypes` 数组中添加 `'Stop'`
  - 位置: `src/bridge/server.ts` ~L152
  - 将 `const validTypes = ['PreToolUse', 'PostToolUse', 'Notification']` 改为 `const validTypes = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop']`
  - 原因: 验证白名单包含 Stop 后，POST /hook 请求 `type: "Stop"` 才不会被拒绝为 400

- [x] 在 `BridgeServer.handleHook()` 中添加 Stop Hook 响应逻辑
  - 位置: `src/bridge/server.ts` ~L191-208，在 approval 处理分支之后、Notification/PostToolUse 转发分支之前（约 ~L189 之后，`// Forward Notification` 注释之前）
  - 添加 Stop 类型判断分支:
    ```typescript
    // Handle Stop hook — return decision format
    if (payload.type === 'Stop') {
      this.logger.info('Stop hook received, approving (Task 2 stub)');
      sendJSON(res, 200, { decision: 'approve' });
      return;
    }
    ```
  - 原因: Stop Hook 的响应格式为 `{decision: "approve"}` 或 `{decision: "block", ...}`，与现有的 `{status: "ok"}` 格式不同，需提前拦截返回；Task 3 将在此处消费 MessageQueue

- [x] 在 `hook-installer.ts` 的 `HooksConfig` 接口中添加 `Stop`
  - 位置: `src/hooks/hook-installer.ts` ~L13-19，`HooksConfig` 接口的 `hooks` 字段
  - 在 `hooks` 类型定义中追加 `Stop: HookEntry[]`，修改后:
    ```typescript
    interface HooksConfig {
      hooks: {
        PreToolUse: HookEntry[];
        PostToolUse: HookEntry[];
        Notification: HookEntry[];
        Stop: HookEntry[];
      };
    }
    ```
  - 原因: `isHooksInstalled()` 遍历模板的所有 hookType 来检查是否安装完整，添加 Stop 后 `isHooksInstalled()` 会自动检查 Stop 条目

- [x] 在 `templates/settings-hooks.json` 中添加 Stop hook 条目
  - 位置: `templates/settings-hooks.json`，在 `"Notification"` 数组之后（文件末尾 `}` 之前）
  - 添加:
    ```json
    "Stop": [
      {
        "matcher": "",
        "command": "curl -s -X POST http://127.0.0.1:9876/hook -H 'X-Token: $REMOTE_TOKEN' -d '$PAYLOAD'"
      }
    ]
    ```
  - 注意: Notification 数组末尾的 `}` 后需要加逗号
  - 原因: 模板定义了安装到 `.claude/settings.json` 的 hooks 配置，缺少 Stop 条目则安装后 CC 不会触发 Stop Hook 回调

- [x] 为 `HookHandler` 的 Stop Hook 支持编写单元测试
  - 测试文件: `src/__tests__/hook-handler.test.ts`
  - 测试场景:
    - `handleStop()` 返回 `{decision: 'approve'}`: payload `type: 'Stop'` → `handler.handle()` 返回 `{ decision: 'approve' }`
    - `handleStop()` 不发送飞书消息: payload `type: 'Stop'` → `feishuClient.getBoundUsersBySession` 未被调用
  - 在 `describe('handle()')` describe 块内或新增 `describe('handleStop')` 块中添加
  - 运行命令: `npx vitest run src/__tests__/hook-handler.test.ts`
  - 预期: 所有测试通过

- [x] 为 `BridgeServer` 的 Stop Hook 支持编写单元测试
  - 测试文件: `src/__tests__/server.test.ts`
  - 测试场景:
    - `POST /hook` with `type: 'Stop'` 返回 `{decision: 'approve'}`: 注册 session 后发送 Stop hook 请求 → statusCode 200，`res.data.decision` 为 `'approve'`
    - `POST /hook` with `type: 'Stop'` 无 token 返回 401: 不携带 X-Token → statusCode 401
    - `POST /hook` with `type: 'Stop'` 无效 token 返回 401: 携带错误 token → statusCode 401
  - 运行命令: `npx vitest run src/__tests__/server.test.ts`
  - 预期: 所有测试通过

- [x] 为 `hook-installer` 的 Stop Hook 支持编写单元测试
  - 测试文件: `src/__tests__/hook-installer.test.ts`
  - 测试场景:
    - `loadTemplate()` 包含 Stop hook 条目: 调用 `loadTemplate()` → `config.hooks.Stop` 存在且长度为 1，command 包含 `'127.0.0.1:9876'`
    - `loadTemplate()` 自定义端口也替换 Stop hook: `loadTemplate(5555)` → `config.hooks.Stop[0].command` 包含 `'127.0.0.1:5555'`
    - `installHooks()` 安装 Stop hook: 安装后读取 settings.json → `settings.hooks.Stop` 长度为 1
    - `isHooksInstalled()` 检查 Stop hook: 安装后 `isHooksInstalled()` 返回 `true`；仅安装缺少 Stop 的配置时返回 `false`
  - 运行命令: `npx vitest run src/__tests__/hook-installer.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 验证 `HookPayload.type` 包含 `'Stop'`
  - `grep -n "'Stop'" src/hooks/hook-handler.ts src/bridge/server.ts src/hooks/hook-installer.ts`
  - 预期: 三个文件均有匹配
- [x] 验证 `settings-hooks.json` 包含 Stop 条目
  - `grep -c '"Stop"' templates/settings-hooks.json`
  - 预期: 输出 1
- [x] 验证 TypeScript 编译无错误
  - `npx tsc --noEmit 2>&1 | tail -5`
  - 预期: 无 error 输出
- [x] 验证全部 Stop Hook 相关测试通过
  - `npx vitest run src/__tests__/hook-handler.test.ts src/__tests__/server.test.ts src/__tests__/hook-installer.test.ts`
  - 预期: 所有测试用例通过

---

### Task 3: 飞书消息转发与 Stop Hook 消费集成

**背景:**
飞书用户发送的非命令文本需要暂存到 MessageQueue，由 Stop Hook 在 CC agent 考虑停止时消费并注入。当前 `FeishuClient.handleMessage()` 在非命令文本分支（~L388-401）仅做日志记录并回复 "Message sent to session"，实际未存储消息；`HookHandler` 无 Stop case（Task 2 将添加但固定返回 `{decision: "approve"}`）；`server.ts` 的 `handleHook()` 未接入 MessageQueue；`entry.ts` 未创建和传递 MessageQueue 实例。本 Task 完成飞书消息入队、Stop Hook 消费队列、响应透传、组件组装四部分集成，实现 spec-design.md 中"机制 1：Stop Hook 注入"的完整数据通路。本 Task 依赖 Task 1（MessageQueue）和 Task 2（Stop Hook 类型支持）的输出。

**涉及文件:**
- 修改: `src/bridge/feishu-client.ts`
- 修改: `src/hooks/hook-handler.ts`
- 修改: `src/bridge/server.ts`
- 修改: `src/bridge/entry.ts`
- 修改: `src/__tests__/feishu-client.test.ts`
- 修改: `src/__tests__/hook-handler.test.ts`
- 修改: `src/__tests__/server.test.ts`

**执行步骤:**
- [x] 在 `FeishuClient` 构造函数中接收 `MessageQueue` 实例
  - 位置: `src/bridge/feishu-client.ts` ~L61-85，`FeishuClient` 类的构造函数
  - 添加 `import type { MessageQueue } from './message-queue.js';`（文件顶部 import 区）
  - 在构造函数参数列表末尾追加 `messageQueue: MessageQueue` 参数（在 `config?: RemoteConfig` 之前），添加 `private readonly messageQueue: MessageQueue` 字段
  - 构造函数签名变为: `constructor(router: SessionRouter, approval: ApprovalManager, messageQueue: MessageQueue, config?: RemoteConfig)`
  - 原因: FeishuClient 需要在收到飞书非命令文本时调用 `messageQueue.enqueue()` 存储消息

- [x] 在 `FeishuClient.handleMessage()` 非命令文本分支中调用 `messageQueue.enqueue()` 并更新回复文案
  - 位置: `src/bridge/feishu-client.ts` ~L388-401，`handleMessage()` 方法中 "Non-command text" 分支
  - 将当前代码:
    ```typescript
    // Non-command text: forward to bound session or show session list
    const binding = this.getBoundSession(openId, chatId);
    if (binding) {
      const instance = this.router.getInstance(binding.sessionToken);
      if (instance && instance.state === 'online') {
        // Forward message - in full implementation this would send to the CC instance
        this.logger.info({ openId, sessionId: instance.sessionId, text }, 'Message forwarded to session');
        await this.sendMessage(openId, `Message sent to session ${instance.sessionId}.`);
      } else {
        await this.sendMessage(openId, 'Bound session is offline. Use /list to bind a new session.');
      }
    } else {
      await this.sendSessionList(openId, chatId);
    }
    ```
    替换为:
    ```typescript
    // Non-command text: enqueue to bound session or show session list
    const binding = this.getBoundSession(openId, chatId);
    if (binding) {
      const instance = this.router.getInstance(binding.sessionToken);
      if (instance && instance.state === 'online') {
        this.messageQueue.enqueue(binding.sessionToken, text, openId);
        this.logger.info({ openId, sessionId: instance.sessionId, text }, 'Message forwarded to session');
        await this.sendMessage(openId, '消息已送达 CC 会话');
      } else {
        await this.sendMessage(openId, 'Bound session is offline. Use /list to bind a new session.');
      }
    } else {
      await this.sendSessionList(openId, chatId);
    }
    ```
  - 关键变化: 添加 `this.messageQueue.enqueue(binding.sessionToken, text, openId)` 调用，回复文案改为 `'消息已送达 CC 会话'`
  - 原因: 飞书消息必须存入 MessageQueue 才能被 Stop Hook 或 MessageInjector 消费

- [x] 在 `HookHandler` 构造函数中接收 `MessageQueue` 实例
  - 位置: `src/hooks/hook-handler.ts` ~L23-32，`HookHandler` 类
  - 添加 `import type { MessageQueue } from '../bridge/message-queue.js';`（文件顶部 import 区）
  - 在构造函数参数列表中追加 `messageQueue: MessageQueue` 参数（在 `feishuClient: FeishuClient` 之后），添加 `private readonly messageQueue: MessageQueue` 字段
  - 构造函数签名变为: `constructor(router: SessionRouter, approval: ApprovalManager, feishuClient: FeishuClient, messageQueue: MessageQueue)`
  - 原因: HookHandler 的 `handleStop()` 需要调用 `messageQueue.hasPending()` 和 `messageQueue.dequeue()` 消费队列

- [x] 将 `handleStop()` 方法从 Task 2 的 stub 替换为消费 MessageQueue 的完整实现
  - 位置: `src/hooks/hook-handler.ts`，替换 Task 2 添加的 `handleStop()` 方法（~L114-118）
  - 方法签名: `private async handleStop(sessionToken: string): Promise<HookResult>`
  - 实现逻辑:
    ```typescript
    private async handleStop(sessionToken: string): Promise<HookResult> {
      if (!this.messageQueue.hasPending(sessionToken)) {
        logger.info('Stop hook: no pending messages, approving');
        return { decision: 'approve' };
      }

      const messages = this.messageQueue.dequeue(sessionToken);
      const formatted = messages
        .map((msg, i) => `[${i + 1}] ${msg.text}`)
        .join('\n');

      logger.info({ sessionToken: sessionToken.slice(0, 8), count: messages.length }, 'Stop hook: blocking with pending messages');

      return {
        decision: 'block',
        reason: `飞书远程消息:\n${formatted}`,
        systemMessage: `飞书远程消息:\n${formatted}`,
      };
    }
    ```
  - 关键逻辑: 先检查 `hasPending`，无消息返回 approve；有消息则 `dequeue` 全部，格式化为 `[1] msg1\n[2] msg2` 格式，返回 `decision: "block"`
  - 原因: 与 spec-design.md 中 Stop Hook 返回格式完全一致，多消息合并为一条 block

- [x] 在 `BridgeServer` 构造函数中接收 `MessageQueue` 实例
  - 位置: `src/bridge/server.ts` ~L42-59，`BridgeServer` 类
  - 添加 `import { MessageQueue } from './message-queue.js';`（文件顶部 import 区）
  - 在 `BridgeServer` 类中添加 `private readonly messageQueue: MessageQueue;` 私有字段
  - 在构造函数参数列表中追加 `messageQueue: MessageQueue` 参数（在 `feishuClient?: FeishuClient | null` 之后、`config?: RemoteConfig` 之前），赋值 `this.messageQueue = messageQueue;`
  - 构造函数签名变为: `constructor(router: SessionRouter, approval: ApprovalManager, feishuClient: FeishuClient | null, messageQueue: MessageQueue, config?: RemoteConfig)`
  - 原因: server.ts 的 `handleHook()` 需要直接访问 MessageQueue 来处理 Stop Hook

- [x] 将 `BridgeServer.handleHook()` 中的 Stop Hook stub 替换为消费 MessageQueue 的完整逻辑
  - 位置: `src/bridge/server.ts`，替换 Task 2 添加的 Stop Hook 处理分支（`if (payload.type === 'Stop')` 块，在 approval 处理分支之后、Notification/PostToolUse 转发分支 `// Forward Notification` 注释之前）
  - 替换为:
    ```typescript
    // Handle Stop hook — check message queue and return decision
    if (payload.type === 'Stop') {
      if (!this.messageQueue.hasPending(matchedToken)) {
        this.logger.info('Stop hook: no pending messages, approving');
        sendJSON(res, 200, { decision: 'approve' });
        return;
      }

      const messages = this.messageQueue.dequeue(matchedToken);
      const formatted = messages
        .map((msg, i) => `[${i + 1}] ${msg.text}`)
        .join('\n');

      this.logger.info({ count: messages.length }, 'Stop hook: blocking with pending messages');
      sendJSON(res, 200, {
        decision: 'block',
        reason: `飞书远程消息:\n${formatted}`,
        systemMessage: `飞书远程消息:\n${formatted}`,
      });
      return;
    }
    ```
  - 关键逻辑: 直接在 server.ts 中消费 MessageQueue，返回 `{decision: "block", reason, systemMessage}` 或 `{decision: "approve"}`，不包裹 `{status: "ok"}`
  - 原因: Stop Hook 的 HTTP 响应格式由 CC 期望的 `decision` 字段决定，必须直接返回而非包裹

- [x] 在 `entry.ts` 中创建 `MessageQueue` 实例并传递给各组件
  - 位置: `src/bridge/entry.ts` ~L1-14，`main()` 函数中组件创建区域
  - 添加 `import { MessageQueue } from './message-queue.js';`（文件顶部 import 区）
  - 在 `const approval = new ApprovalManager(router, config);` 之后（~L12 之后）添加:
    ```typescript
    const messageQueue = new MessageQueue();
    ```
  - 修改 `FeishuClient` 构造调用（~L13），添加 messageQueue 参数:
    ```typescript
    const feishuClient = new FeishuClient(router, approval, messageQueue, config);
    ```
  - 修改 `BridgeServer` 构造调用（~L14），添加 messageQueue 参数:
    ```typescript
    const server = new BridgeServer(router, approval, feishuClient, messageQueue, config);
    ```
  - 在 `shutdown` 函数中（~L27，`router.destroy()` 之前）添加 `messageQueue.destroy();`
  - 原因: entry.ts 是 Bridge 组件组装入口，MessageQueue 需要在此时创建并注入到 FeishuClient（生产端）和 BridgeServer（消费端）

- [x] 更新 `feishu-client.test.ts` 中 FeishuClient 构造函数调用以传入 MessageQueue mock
  - 位置: `src/__tests__/feishu-client.test.ts`
  - 在文件顶部添加 `import { MessageQueue } from '../bridge/message-queue.js';`
  - 在 `createTestClient()` 函数（~L40-45）中:
    - 添加 `const messageQueue = new MessageQueue();` 创建实例
    - 修改构造调用为 `new FeishuClient(router, approval, messageQueue, config)`
  - 在 `describe('FeishuClient')` 的 `beforeEach`（~L85-89）中:
    - 添加 `const messageQueue = new MessageQueue();`
    - 修改构造调用为 `new FeishuClient(router, approval, messageQueue, testConfig)`
  - 原因: FeishuClient 构造函数签名变更后所有测试需同步更新

- [x] 更新 `hook-handler.test.ts` 中 HookHandler 构造函数调用以传入 MessageQueue 实例
  - 位置: `src/__tests__/hook-handler.test.ts`
  - 在文件顶部添加 `import { MessageQueue } from '../bridge/message-queue.js';`
  - 在 `beforeEach`（~L33-40）中添加 `const messageQueue = new MessageQueue();`
  - 修改构造调用为 `handler = new HookHandler(router, approval, feishuClient, messageQueue);`

- [x] 更新 `server.test.ts` 中 BridgeServer 构造函数调用以传入 MessageQueue 实例
  - 位置: `src/__tests__/server.test.ts`
  - 在文件顶部添加 `import { MessageQueue } from '../bridge/message-queue.js';`
  - 在 `beforeEach`（~L47-52）中添加 `let messageQueue: MessageQueue;`，在 beforeEach 体内添加 `messageQueue = new MessageQueue();`
  - 修改构造调用为 `server = new BridgeServer(router, approval, null, messageQueue, testConfig);`
  - 在 `afterEach`（~L55-58）中 `router.destroy()` 之前添加 `messageQueue.destroy();`

- [x] 为 FeishuClient 消息入队编写单元测试
  - 测试文件: `src/__tests__/feishu-client.test.ts`
  - 测试场景:
    - 非命令文本入队: 绑定 session 后发送 `'hello world'` → `messageQueue.hasPending(token)` 为 `true`，`dequeue(token)` 返回包含 `{text: 'hello world', openId: 'ou_user_allowed'}` 的数组
    - 入队后回复确认文案: 发送非命令文本 → `sendMessage` 的调用参数包含 `'消息已送达 CC 会话'`
    - 未绑定 session 不入队: 未绑定 session 时发送 `'hello'` → `messageQueue.hasPending()` 为 `false`
    - session 离线不入队: 绑定 session 后将其 state 设为 Disconnected，发送文本 → `messageQueue.hasPending()` 为 `false`，`sendMessage` 参数包含 `'offline'`
    - 多条消息入队顺序正确: 连续发送 3 条消息 → `dequeue()` 返回 3 条，顺序与发送顺序一致
  - 运行命令: `npx vitest run src/__tests__/feishu-client.test.ts`
  - 预期: 所有测试通过

- [x] 为 HookHandler Stop Hook 消费编写单元测试
  - 测试文件: `src/__tests__/hook-handler.test.ts`
  - 测试场景:
    - 无待处理消息返回 approve: `payload.type: 'Stop'` → `handler.handle()` 返回 `{decision: 'approve'}`
    - 有待处理消息返回 block: 入队 1 条消息后发送 Stop payload → 返回 `{decision: 'block', reason: '飞书远程消息:\n[1] hello', systemMessage: '飞书远程消息:\n[1] hello'}`
    - 多条消息合并格式化: 入队 3 条消息后 Stop → `reason` 包含 `[1] msg1\n[2] msg2\n[3] msg3`
    - dequeue 后队列清空: 入队 2 条后 Stop（返回 block）→ 再次 Stop 返回 `{decision: 'approve'}`
    - Stop 不发送飞书消息: Stop payload → `feishuClient.getBoundUsersBySession` 未被调用
  - 运行命令: `npx vitest run src/__tests__/hook-handler.test.ts`
  - 预期: 所有测试通过

- [x] 为 BridgeServer Stop Hook 端到端编写单元测试
  - 测试文件: `src/__tests__/server.test.ts`
  - 测试场景:
    - Stop 无消息返回 approve: 注册 session 后 POST /hook `type: 'Stop'` → statusCode 200，`res.data.decision` 为 `'approve'`
    - Stop 有消息返回 block: 注册 session，通过 MessageQueue 入队 1 条消息，POST /hook `type: 'Stop'` → statusCode 200，`res.data.decision` 为 `'block'`，`res.data.reason` 包含 `[1]`，`res.data.systemMessage` 包含 `飞书远程消息`
    - Stop 消费后队列清空: 入队消息后 Stop（block）→ 再次 Stop → `decision` 为 `'approve'`
    - Stop 无 token 返回 401: 不携带 X-Token → statusCode 401
    - Stop 无效 token 返回 401: 携带错误 token → statusCode 401
    - 多条消息 Stop 合并: 入队 2 条消息后 Stop → `reason` 包含 `[1]` 和 `[2]`
  - 运行命令: `npx vitest run src/__tests__/server.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 验证 FeishuClient 构造函数接收 MessageQueue
  - `grep -n 'messageQueue' src/bridge/feishu-client.ts | head -5`
  - 预期: 包含构造函数参数和 `enqueue` 调用
- [x] 验证 HookHandler.handleStop() 消费 MessageQueue
  - `grep -n 'hasPending\|dequeue' src/hooks/hook-handler.ts`
  - 预期: 两处匹配（hasPending 检查和 dequeue 调用）
- [x] 验证 server.ts Stop Hook 返回 decision 格式
  - `grep -n 'decision' src/bridge/server.ts`
  - 预期: 包含 `'approve'` 和 `'block'` 两处
- [x] 验证 entry.ts 创建并传递 MessageQueue
  - `grep -n 'MessageQueue\|messageQueue' src/bridge/entry.ts`
  - 预期: 包含 import、实例创建、传递给 FeishuClient 和 BridgeServer、destroy 调用
- [x] 验证 TypeScript 编译无错误
  - `npx tsc --noEmit 2>&1 | tail -5`
  - 预期: 无 error 输出
- [x] 验证全部相关测试通过
  - `npx vitest run src/__tests__/feishu-client.test.ts src/__tests__/hook-handler.test.ts src/__tests__/server.test.ts`
  - 预期: 所有测试用例通过

---

### Task 4: 终端信息收集与注册扩展

**背景:**
飞书远程控制的双机制消息注入方案中，"CC 空闲中" 场景（Task 5: MessageInjector）需要通过终端注入机制（osascript / tmux send-keys）向 CC 输入文本，这要求注册时收集 CC 所在终端的类型和标识信息（tmux session/pane 或 Terminal.app）。当前 `SessionInstance` 接口仅有 token、sessionId、workdir、state 等基础字段，无终端信息；`SessionRouter.register()` 仅接收 sessionId 和 workdir；`BridgeServer.handleRegister()` 不解析 terminal 字段；`/remote` Skill 的注册流程不检测终端环境。本 Task 在数据模型、路由、HTTP 端点、Skill 定义四个层面补齐终端信息收集能力，为 Task 5（MessageInjector）提供终端注入所需的完整信息。

**涉及文件:**
- 修改: `src/bridge/router.ts`
- 修改: `src/bridge/server.ts`
- 修改: `src/skill/remote.md`
- 修改: `src/__tests__/router.test.ts`
- 修改: `src/__tests__/server.test.ts`
- 修改: `src/__tests__/skill.test.ts`

**执行步骤:**
- [x] 在 `router.ts` 中新增 `TerminalInfo` 接口，扩展 `SessionInstance` 接口
  - 位置: `src/bridge/router.ts` ~L13-20，`SessionInstance` 接口定义之前
  - 在 `SessionInstance` 接口之前新增导出接口:
    ```typescript
    export interface TerminalInfo {
      type: 'tmux' | 'terminal' | 'vscode';
      tmuxSession?: string;
      tmuxPane?: string;
    }
    ```
  - 在 `SessionInstance` 接口中，在 `lastHeartbeat: number;` 字段之后追加可选字段 `terminal?: TerminalInfo;`
  - 修改后 `SessionInstance` 完整定义为:
    ```typescript
    export interface SessionInstance {
      token: string;
      sessionId: string;
      workdir: string;
      state: SessionState;
      registeredAt: number;
      lastHeartbeat: number;
      terminal?: TerminalInfo;
    }
    ```
  - 原因: Task 5 MessageInjector 需要读取 `terminal` 字段来决定注入方式（tmux send-keys / osascript / 不支持）

- [x] 扩展 `SessionRouter.register()` 方法签名，接受可选 `terminal` 参数
  - 位置: `src/bridge/router.ts` ~L33，`register()` 方法定义
  - 将方法签名从 `register(sessionId: string, workdir: string): { token: string }` 改为 `register(sessionId: string, workdir: string, terminal?: TerminalInfo): { token: string }`
  - 在 instance 对象构建中，在 `lastHeartbeat: now,` 之后追加 `terminal,`
  - 修改后的 instance 构建为:
    ```typescript
    const instance: SessionInstance = {
      token,
      sessionId,
      workdir,
      state: SessionState.Online,
      registeredAt: now,
      lastHeartbeat: now,
      terminal,
    };
    ```
  - 在 `logger.info` 调用中追加 terminal 信息: `this.logger.info({ sessionId, workdir, terminalType: terminal?.type }, 'Session registered');`
  - 原因: register() 需要将 terminal 信息持久化到 SessionInstance 中供后续查询

- [x] 更新 `BridgeServer.handleRegister()` 解析并传递 `terminal` 字段
  - 位置: `src/bridge/server.ts` ~L211-239，`handleRegister()` 方法
  - 将请求体类型定义从 `{ session_id?: string; workdir?: string }` 改为:
    ```typescript
    let data: { session_id?: string; workdir?: string; terminal?: { type?: string; tmuxSession?: string; tmuxPane?: string } };
    ```
  - 在 workdir 校验通过后（~L237 之后），添加 terminal 解析逻辑:
    ```typescript
    // Parse optional terminal info
    let terminal: { type: 'tmux' | 'terminal' | 'vscode'; tmuxSession?: string; tmuxPane?: string } | undefined;
    if (data.terminal && data.terminal.type) {
      const validTypes = ['tmux', 'terminal', 'vscode'];
      if (validTypes.includes(data.terminal.type)) {
        terminal = {
          type: data.terminal.type as 'tmux' | 'terminal' | 'vscode',
          tmuxSession: data.terminal.tmuxSession,
          tmuxPane: data.terminal.tmuxPane,
        };
      }
    }
    ```
  - 将 `this.router.register()` 调用从 `this.router.register(data.session_id, data.workdir)` 改为 `this.router.register(data.session_id, data.workdir, terminal)`
  - 原因: handleRegister() 是 /register 端点的处理逻辑，需要将请求体中的 terminal 字段解析并传递给 SessionRouter

- [x] 更新 `src/skill/remote.md` 连接注册流程，在 Step 3 和 Step 4 之间新增终端检测步骤，修改 Step 4 的 curl payload
  - 位置: `src/skill/remote.md` ~L28-34，连接注册 section 的 Step 3 和 Step 4 之间
  - 在 Step 3（生成 SESSION_ID）之后、Step 4（注册）之前，插入新的终端检测步骤:
    ```
    4. Detect the terminal environment where Claude Code is running:
       - Check if running inside tmux by executing:
         ```
         echo $TMUX
         ```
         If the output is non-empty, parse it to extract tmux session and pane identifiers:
         ```
         TMUX_PANE_ID=$(echo $TMUX | cut -d, -f2)
         TMUX_SESSION_NAME=$(tmux list-panes -t "$TMUX_PANE_ID" -F '#{session_name}' 2>/dev/null)
         TMUX_PANE_INDEX=$(tmux list-panes -t "$TMUX_PANE_ID" -F '#{pane_index}' 2>/dev/null)
         ```
         Save `TMUX_SESSION_NAME` as `TMUX_SESSION` and `TMUX_PANE_INDEX` as `TMUX_PANE`.
         Set `TERMINAL_TYPE` to `tmux`.
       - If `$TMUX` is empty, check if the `TERM_PROGRAM` environment variable equals `vscode` by executing:
         ```
         echo $TERM_PROGRAM
         ```
         If the output is `vscode`, set `TERMINAL_TYPE` to `vscode`.
       - Otherwise, set `TERMINAL_TYPE` to `terminal`.
  - 更新原 Step 4（现改为 Step 5）的 curl 命令，在 JSON payload 中加入 terminal 字段:
    - 如果 `TERMINAL_TYPE` 为 `tmux`:
      ```
      curl -s -X POST http://127.0.0.1:9876/register \
        -H "Content-Type: application/json" \
        -d '{"session_id":"SESSION_ID","workdir":"WORKDIR","terminal":{"type":"tmux","tmuxSession":"TMUX_SESSION","tmuxPane":"TMUX_PANE"}}'
      ```
    - 如果 `TERMINAL_TYPE` 为 `terminal` 或 `vscode`:
      ```
      curl -s -X POST http://127.0.0.1:9876/register \
        -H "Content-Type: application/json" \
        -d '{"session_id":"SESSION_ID","workdir":"WORKDIR","terminal":{"type":"TERMINAL_TYPE"}}'
      ```
  - 后续步骤编号顺延（原 Step 5 变为 Step 6，以此类推）
  - 原因: 注册时收集终端信息是 spec-design.md 中 "/remote Skill - 注册时额外收集终端信息" 的明确要求，MessageInjector 依赖此信息选择注入方式

- [x] 为 `SessionRouter.register()` 的 terminal 参数扩展编写单元测试
  - 测试文件: `src/__tests__/router.test.ts`
  - 测试场景:
    - `register()` 不传 terminal: 调用 `router.register('sess-1', '/tmp/test')` → `getInstance(token).terminal` 为 `undefined`
    - `register()` 传入 tmux terminal: 调用 `router.register('sess-1', '/tmp/test', { type: 'tmux', tmuxSession: '0', tmuxPane: '1' })` → `getInstance(token).terminal` 为 `{ type: 'tmux', tmuxSession: '0', tmuxPane: '1' }`
    - `register()` 传入 terminal 类型: 调用 `router.register('sess-1', '/tmp/test', { type: 'terminal' })` → `getInstance(token).terminal` 为 `{ type: 'terminal' }`，`tmuxSession` 和 `tmuxPane` 均为 `undefined`
    - `register()` 传入 vscode 类型: 调用 `router.register('sess-1', '/tmp/test', { type: 'vscode' })` → `getInstance(token).terminal!.type` 为 `'vscode'`
  - 运行命令: `npx vitest run src/__tests__/router.test.ts`
  - 预期: 所有测试通过

- [x] 为 `BridgeServer` /register 端点的 terminal 字段解析编写单元测试
  - 测试文件: `src/__tests__/server.test.ts`
  - 测试场景:
    - `/register` 带 tmux terminal: 请求体 `{"session_id":"s1","workdir":"/tmp","terminal":{"type":"tmux","tmuxSession":"0","tmuxPane":"0"}}` → statusCode 200，通过 `server.getRouter().getInstance(res.data.token).terminal` 验证 terminal 值正确
    - `/register` 带 terminal 类型: 请求体 `{"session_id":"s1","workdir":"/tmp","terminal":{"type":"terminal"}}` → statusCode 200，terminal.type 为 `'terminal'`，tmuxSession/tmuxPane 为 undefined
    - `/register` 不带 terminal: 请求体 `{"session_id":"s1","workdir":"/tmp"}` → statusCode 200，terminal 为 undefined
    - `/register` 带无效 terminal type: 请求体 `{"session_id":"s1","workdir":"/tmp","terminal":{"type":"unknown"}}` → statusCode 200，terminal 为 undefined（无效 type 被忽略，不报错）
    - `/register` 带 vscode terminal: 请求体 `{"session_id":"s1","workdir":"/tmp","terminal":{"type":"vscode"}}` → statusCode 200，terminal.type 为 `'vscode'`
  - 运行命令: `npx vitest run src/__tests__/server.test.ts`
  - 预期: 所有测试通过

- [x] 为 `remote.md` 终端检测内容编写单元测试
  - 测试文件: `src/__tests__/skill.test.ts`
  - 测试场景:
    - remote.md 提及 tmux 环境变量检测: `content` 包含 `'$TMUX'` 或 `'$TMUX'`
    - remote.md 提及终端类型选项: `content` 包含 `'tmux'` 且包含 `'terminal'`
    - remote.md 注册 payload 包含 terminal 字段: 在连接注册 section 中包含 `'terminal'`
  - 运行命令: `npx vitest run src/__tests__/skill.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 验证 `TerminalInfo` 接口已导出
  - `grep -n 'export interface TerminalInfo' src/bridge/router.ts`
  - 预期: 输出 1 行，包含接口定义
- [x] 验证 `SessionInstance` 包含 `terminal` 可选字段
  - `grep -n 'terminal' src/bridge/router.ts`
  - 预期: 至少 3 处匹配（接口字段、register 参数、instance 构建）
- [x] 验证 `handleRegister()` 解析并传递 terminal
  - `grep -n 'terminal' src/bridge/server.ts`
  - 预期: 至少 4 处匹配（data 类型、解析逻辑、register 调用）
- [x] 验证 `remote.md` 包含 tmux 检测步骤
  - `grep -c 'TMUX' src/skill/remote.md`
  - 预期: 输出 >= 2
- [x] 验证 `remote.md` 注册请求包含 terminal 字段
  - `grep -c 'terminal' src/skill/remote.md`
  - 预期: 输出 >= 2
- [x] 验证 TypeScript 编译无错误
  - `npx tsc --noEmit 2>&1 | tail -5`
  - 预期: 无 error 输出
- [x] 验证全部相关测试通过
  - `npx vitest run src/__tests__/router.test.ts src/__tests__/server.test.ts src/__tests__/skill.test.ts`
  - 预期: 所有测试用例通过

---

### Task 5: 空闲消息注入器

**背景:**
飞书远程控制的双机制消息注入方案中，"CC 空闲中" 场景需要 MessageInjector 后台进程处理：当 CC 完成任务等待用户输入时，无 Hook 会触发，无法通过 Stop Hook 注入消息。MessageInjector 以 3 秒间隔轮询 MessageQueue，检测到有待处理消息且 CC 空闲（最近 5 秒无 Hook 活动）时，通过终端注入机制（tmux send-keys / osascript）将消息文本输入到 CC 终端。当前代码库中 `src/bridge/` 不存在 `message-injector.ts`；`entry.ts` 未创建和启动 MessageInjector。本 Task 实现 MessageInjector 类，修改 `entry.ts` 完成组件组装，是双机制方案的最后一环。依赖 Task 1（MessageQueue）、Task 4（TerminalInfo 扩展）的输出。

**涉及文件:**
- 新建: `src/bridge/message-injector.ts`
- 修改: `src/bridge/entry.ts`
- 新建: `src/__tests__/message-injector.test.ts`

**执行步骤:**
- [x] 创建 `src/bridge/message-injector.ts`，定义 `MessageInjector` 类骨架
  - 位置: 新文件 `src/bridge/message-injector.ts`
  - 添加导入:
    ```typescript
    import { execFile } from 'child_process';
    import { promisify } from 'util';
    import type { MessageQueue, QueuedMessage } from './message-queue.js';
    import type { SessionRouter } from './router.js';
    import type { FeishuClient } from './feishu-client.js';
    import { createLogger } from '../utils/logger.js';
    import { getPlatform } from '../utils/platform.js';

    const execFileAsync = promisify(execFile);
    ```
  - 导出 `MessageInjector` 类，包含以下私有字段:
    ```typescript
    private readonly queue: MessageQueue;
    private readonly router: SessionRouter;
    private readonly feishuClient: FeishuClient;
    private readonly logger = createLogger('message-injector');
    private intervalHandle: NodeJS.Timeout | null = null;
    private readonly IDLE_THRESHOLD_MS = 5000;
    private readonly INJECT_INTERVAL_MS = 3000;
    ```
  - 构造函数签名: `constructor(queue: MessageQueue, router: SessionRouter, feishuClient: FeishuClient)`
  - 构造函数体赋值 `this.queue`、`this.router`、`this.feishuClient`
  - 原因: MessageInjector 需要访问 MessageQueue（消费消息）、SessionRouter（读取 SessionInstance 的 lastHeartbeat 和 terminal 信息）、FeishuClient（发送注入确认消息）

- [x] 实现 `start(intervalMs?: number): void` 方法
  - 位置: `MessageInjector.start()`
  - 逻辑:
    ```typescript
    start(intervalMs?: number): void {
      const interval = intervalMs ?? this.INJECT_INTERVAL_MS;
      if (this.intervalHandle) {
        this.logger.warn('MessageInjector already running');
        return;
      }
      this.intervalHandle = setInterval(() => this.tick(), interval);
      this.logger.info({ intervalMs: interval }, 'MessageInjector started');
    }
    ```
  - 原因: 启动轮询循环，提供可选 intervalMs 参数便于测试时使用短间隔

- [x] 实现 `stop(): void` 方法
  - 位置: `MessageInjector.stop()`
  - 逻辑:
    ```typescript
    stop(): void {
      if (this.intervalHandle) {
        clearInterval(this.intervalHandle);
        this.intervalHandle = null;
        this.logger.info('MessageInjector stopped');
      }
    }
    ```
  - 原因: Bridge 关闭时需停止轮询，释放 interval 资源

- [x] 实现 `private tick(): void` 方法 — 主循环逻辑
  - 位置: `MessageInjector.tick()`
  - 逻辑:
    ```typescript
    private tick(): void {
      const sessions = this.queue.getSessionsWithPending();
      if (sessions.length === 0) return;

      for (const sessionToken of sessions) {
        if (!this.isSessionIdle(sessionToken)) continue;

        const messages = this.queue.dequeue(sessionToken);
        if (messages.length === 0) continue;

        this.injectToTerminal(sessionToken, messages).catch((err) => {
          this.logger.error({ err, sessionToken: sessionToken.slice(0, 8) }, 'Failed to inject messages');
        });
      }
    }
    ```
  - 关键设计: 先 dequeue 再注入；若注入失败，消息已从队列移除（Stop Hook 无法再次消费），但该场景下 CC 已空闲，注入失败后消息丢失是可接受的——日志记录错误即可
  - 原因: 主循环按 session 遍历，仅对空闲 session 执行注入，避免干扰正在工作的 CC

- [x] 实现 `private isSessionIdle(sessionToken: string): boolean` 方法
  - 位置: `MessageInjector.isSessionIdle()`
  - 逻辑:
    ```typescript
    private isSessionIdle(sessionToken: string): boolean {
      const instance = this.router.getInstance(sessionToken);
      if (!instance) return false;
      if (instance.state !== 'online') return false;
      const elapsed = Date.now() - instance.lastHeartbeat;
      return elapsed > this.IDLE_THRESHOLD_MS;
    }
    ```
  - 关键逻辑: `lastHeartbeat` 由所有 Hook 类型（PreToolUse、PostToolUse、Notification、Stop）通过 `router.heartbeat()` 更新，因此任何 Hook 活动 < 5 秒前都意味着 CC 正在工作
  - 原因: 5 秒空闲阈值与 spec-design.md 中"最近 5 秒无 Hook 活动"一致

- [x] 实现 `private async injectToTerminal(sessionToken: string, messages: QueuedMessage[]): Promise<void>` 方法
  - 位置: `MessageInjector.injectToTerminal()`
  - 逻辑:
    ```typescript
    private async injectToTerminal(sessionToken: string, messages: QueuedMessage[]): Promise<void> {
      const instance = this.router.getInstance(sessionToken);
      if (!instance?.terminal) {
        this.logger.warn({ sessionToken: sessionToken.slice(0, 8) }, 'No terminal info, skipping injection');
        return;
      }

      const { terminal } = instance;

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        try {
          if (terminal.type === 'tmux' && terminal.tmuxSession && terminal.tmuxPane) {
            await this.injectViaTmux(terminal.tmuxSession, terminal.tmuxPane, msg.text);
          } else if (terminal.type === 'terminal' && getPlatform() === 'macos') {
            await this.injectViaOsascript(msg.text);
          } else {
            this.logger.warn(
              { sessionToken: sessionToken.slice(0, 8), terminalType: terminal.type, platform: getPlatform() },
              'Unsupported terminal/platform for injection, skipping'
            );
            continue;
          }

          this.logger.info(
            { sessionToken: sessionToken.slice(0, 8), textLength: msg.text.length, index: i + 1, total: messages.length },
            'Message injected to terminal'
          );

          // Notify Feishu user
          await this.feishuClient.sendMessage(msg.openId, '消息已注入到 CC 会话');

          // Delay between messages (500ms) if more messages remain
          if (i < messages.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (err) {
          this.logger.error(
            { err, sessionToken: sessionToken.slice(0, 8), index: i + 1 },
            'Failed to inject message to terminal'
          );
          // Continue with next message
        }
      }
    }
    ```
  - 关键逻辑: 逐条注入，每条间隔 500ms；tmux 使用 `injectViaTmux`，macOS terminal 使用 `injectViaOsascript`，其他情况 log warning 跳过；注入成功后通过飞书回复确认
  - 原因: 多条消息逐条注入 + 间隔与 spec-design.md 中"MessageInjector 按队列顺序逐条注入，每条间隔 500ms"一致

- [x] 实现 `private async injectViaTmux(session: string, pane: string, text: string): Promise<void>` 方法
  - 位置: `MessageInjector.injectViaTmux()`
  - 逻辑:
    ```typescript
    private async injectViaTmux(session: string, pane: string, text: string): Promise<void> {
      const target = `${session}:${pane}`;
      // Inject text
      await execFileAsync('tmux', ['send-keys', '-t', target, text]);
      // Inject Enter key
      await execFileAsync('tmux', ['send-keys', '-t', target, 'Enter']);
      this.logger.debug({ target, textLength: text.length }, 'Injected via tmux');
    }
    ```
  - 关键逻辑: 先 send-keys 注入文本，再 send-keys Enter 发送；tmux send-keys 不需要对文本做 shell 转义（参数通过数组传递给 execFile）
  - 原因: tmux send-keys 是 Linux 下最可靠的终端注入方式，支持后台会话

- [x] 实现 `private async injectViaOsascript(text: string): Promise<void>` 方法
  - 位置: `MessageInjector.injectViaOsascript()`
  - 逻辑:
    ```typescript
    private async injectViaOsascript(text: string): Promise<void> {
      const escaped = this.escapeForOsascript(text);
      const script = `tell application "System Events" to keystroke "${escaped}"`;
      await execFileAsync('osascript', ['-e', script]);
      // Inject Enter key
      const enterScript = 'tell application "System Events" to keystroke return';
      await execFileAsync('osascript', ['-e', enterScript]);
      this.logger.debug({ textLength: text.length }, 'Injected via osascript');
    }
    ```
  - 关键逻辑: 先注入文本（keystroke），再注入回车（keystroke return）；文本需要通过 `escapeForOsascript` 转义
  - 原因: osascript 是 macOS 下通过辅助功能 API 向前台终端注入文本的标准方式

- [x] 实现 `private escapeForOsascript(text: string): string` 方法
  - 位置: `MessageInjector.escapeForOsascript()`
  - 逻辑:
    ```typescript
    private escapeForOsascript(text: string): string {
      return text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, ' ');
    }
    ```
  - 关键逻辑: 转义反斜杠、双引号，将换行替换为空格（keystroke 不支持换行注入）
  - 原因: AppleScript 字符串中的双引号和反斜杠必须转义，换行字符无法通过 keystroke 注入（需要 key code 36），简化为空格

- [x] 修改 `src/bridge/entry.ts`，创建并管理 MessageInjector 生命周期
  - 位置: `src/bridge/entry.ts` ~L1-38，`main()` 函数
  - 在文件顶部 import 区（~L5-6 之后）添加:
    ```typescript
    import { MessageInjector } from './message-injector.js';
    ```
  - 在组件创建区域，`const feishuClient = new FeishuClient(...)` 之后（~L13 之后）添加:
    ```typescript
    const injector = new MessageInjector(messageQueue, router, feishuClient);
    ```
    注意: `messageQueue` 变量由 Task 3 在此处创建，变量名以此为准
  - 在 `await feishuClient.start();` 之后（~L18 之后）添加:
    ```typescript
    injector.start();
    ```
  - 在 `shutdown` 函数中，`await feishuClient.stop();` 之前（~L24 之前）添加:
    ```typescript
    injector.stop();
    ```
  - 原因: MessageInjector 是"机制 2"的执行器，在 Bridge 启动后开始轮询，在 Bridge 关闭前停止；与 feishuClient 的生命周期绑定

- [x] 为 `MessageInjector` 编写单元测试
  - 测试文件: `src/__tests__/message-injector.test.ts`
  - 测试场景:
    - `start()` 启动轮询: 调用 `injector.start(100)` → `intervalHandle` 不为 null（通过 `(injector as any).intervalHandle` 验证）
    - `start()` 重复调用不创建新 interval: 连续两次 `start()` → 第二次不覆盖，日志输出 warn
    - `stop()` 停止轮询: `start()` 后 `stop()` → `intervalHandle` 为 null
    - `stop()` 未启动时调用无异常: 未 start 直接 stop → 无错误
    - `tick()` 无待处理消息时不注入: 队列为空 → 不调用 `execFile`，不调用飞书
    - `tick()` 跳过忙碌 session: 入队消息，设置 `lastHeartbeat = Date.now()`（< 5秒） → 不注入
    - `tick()` 注入空闲 tmux session: 入队消息，设置 `lastHeartbeat` 为 6 秒前，设置 `terminal: { type: 'tmux', tmuxSession: '0', tmuxPane: '1' }` → mock `execFileAsync` 验证调用 `tmux send-keys -t 0:1 "text"` 和 `tmux send-keys -t 0:1 Enter`
    - `tick()` 注入空闲 macOS terminal: 入队消息，设置 `lastHeartbeat` 为 6 秒前，设置 `terminal: { type: 'terminal' }`，mock `getPlatform` 返回 `'macos'` → 验证调用 `osascript -e 'tell application "System Events" to keystroke "..."'` 和回车
    - `tick()` 不支持的终端类型跳过: 设置 `terminal: { type: 'vscode' }` → 不注入，日志输出 warn
    - `tick()` 多条消息顺序注入: 入队 3 条消息，设置空闲 → mock 验证 `execFileAsync` 被调用 6 次（每条消息 2 次：text + Enter），顺序与入队顺序一致
    - `tick()` 注入失败不中断后续消息: mock `execFileAsync` 第 2 条抛出错误 → 第 3 条仍然注入
    - `tick()` 无 terminal 信息跳过注入: 不设置 `terminal` 字段 → 不注入，日志输出 warn
    - `tick()` session 不存在跳过: 入队消息但 router 无对应 session → 不注入
    - `tick()` session 不在线跳过: 设置 session state 为 Disconnected → 不注入
    - `escapeForOsascript()` 转义正确: 输入 `'hello "world"\nline2'` → 输出 `'hello \\"world\\" line2'`
  - Mock 策略:
    - `MessageQueue`: 创建真实实例，通过 `enqueue()` 入队测试数据
    - `SessionRouter`: 创建真实实例，通过 `register()` 注册 session，手动修改 `lastHeartbeat` 和 `terminal` 字段
    - `FeishuClient`: mock 对象，仅 stub `sendMessage()` 方法
    - `child_process.execFile`: 使用 `vi.mock('child_process')` mock `execFile`
    - `../utils/platform.js`: 使用 `vi.mock` mock `getPlatform` 返回值
  - 运行命令: `npx vitest run src/__tests__/message-injector.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 验证 `message-injector.ts` 导出 MessageInjector 类
  - `grep -c 'export class MessageInjector' src/bridge/message-injector.ts`
  - 预期: 输出 1
- [x] 验证 `MessageInjector` 包含全部核心方法
  - `grep -E '^\s+(start|stop|private tick|private isSessionIdle|private async injectToTerminal|private async injectViaTmux|private async injectViaOsascript|private escapeForOsascript)\(' src/bridge/message-injector.ts | wc -l`
  - 预期: 输出 8
- [x] 验证 `entry.ts` 创建并管理 MessageInjector
  - `grep -n 'MessageInjector\|injector' src/bridge/entry.ts`
  - 预期: 包含 import、实例创建、start() 调用、stop() 调用
- [x] 验证 TypeScript 编译无错误
  - `npx tsc --noEmit 2>&1 | tail -5`
  - 预期: 无 error 输出
- [x] 验证 MessageInjector 单元测试全部通过
  - `npx vitest run src/__tests__/message-injector.test.ts`
  - 预期: 所有测试用例通过

---

### Task 6: 飞书远程控制（增量）验收

**前置条件:**
- 构建项目: `npm run build`
- 确保 `~/.claude-remote/config.json` 中已配置有效的飞书 App ID/Secret
- 准备一个飞书测试账号（在 `allowedUsers` 白名单中）
- CC 运行在 tmux 会话中（用于终端注入测试）或 macOS Terminal.app（用于 osascript 注入测试）

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `npx vitest run 2>&1`
   - 预期: 全部测试通过，无失败用例
   - 失败排查: 检查各 Task 的单元测试步骤，逐个排查失败模块

2. 验证 TypeScript 编译无错误
   - `npx tsc --noEmit 2>&1 | grep -c error`
   - 预期: 输出 0
   - 失败排查: 检查类型定义是否与实现匹配

3. 验证新增文件结构完整
   - `ls src/bridge/message-queue.ts src/bridge/message-injector.ts src/__tests__/message-queue.test.ts src/__tests__/message-injector.test.ts`
   - 预期: 4 个文件全部存在
   - 失败排查: 检查 Task 1 和 Task 5 是否执行完成

4. 验证 Stop Hook 类型全链路贯通
   - 注册会话后发送 Stop Hook:
     ```bash
     TOKEN=$(curl -s -X POST http://127.0.0.1:9876/register -H 'Content-Type: application/json' -d '{"session_id":"e2e-test","workdir":"/tmp/test","terminal":{"type":"terminal"}}' | jq -r .token)
     curl -s -X POST http://127.0.0.1:9876/hook -H 'Content-Type: application/json' -H "X-Token: $TOKEN" -d '{"type":"Stop","session_id":"e2e-test","content":""}'
     ```
   - 预期: 返回 `{"decision":"approve"}`
   - 失败排查: 检查 Task 2（Stop Hook 类型支持）和 Task 3（Stop Hook 消费集成）

5. 验证消息队列端到端（飞书消息入队 → Stop Hook 出队）
   - 先通过飞书发送一条文本消息给绑定的 CC 实例
   - 再触发 Stop Hook（CC 完成任务考虑停止时）:
     ```bash
     curl -s -X POST http://127.0.0.1:9876/hook -H 'Content-Type: application/json' -H "X-Token: $TOKEN" -d '{"type":"Stop","session_id":"e2e-test","content":""}'
     ```
   - 预期: 返回 `{"decision":"block","reason":"飞书远程消息:\n[1] ...","systemMessage":"飞书远程消息:\n[1] ..."}`
   - 失败排查: 检查 Task 1（MessageQueue）+ Task 3（飞书消息转发集成）

6. 验证终端信息收集
   - 使用包含 terminal 信息的 payload 注册:
     ```bash
     curl -s -X POST http://127.0.0.1:9876/register -H 'Content-Type: application/json' -d '{"session_id":"term-test","workdir":"/tmp","terminal":{"type":"tmux","tmuxSession":"0","tmuxPane":"0"}}'
     ```
   - 预期: 注册成功，返回 token
   - 通过 `/status` 知看注册的会话是否包含 terminal 信息
   - 失败排查: 检查 Task 4（终端信息收集与注册扩展）

7. 验证 hooks 模板包含 Stop 类型
   - `cat templates/settings-hooks.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(list(d['hooks'].keys()))"`
   - 预期: 输出包含 `Stop`
   - 失败排查: 检查 Task 2（hook 模板更新）

8. 验证空闲注入器生命周期
   - 启动 Bridge 后观察日志，确认 MessageInjector 已启动
   - 停止 Bridge 后确认 injector 已停止
   - 失败排查: 检查 Task 5（MessageInjector）+ entry.ts 生命周期管理

