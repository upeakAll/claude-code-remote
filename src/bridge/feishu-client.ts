import * as lark from '@larksuiteoapi/node-sdk';
import { SessionRouter } from './router.js';
import { ApprovalManager } from './approval.js';
import type { ApprovalRequest } from './approval.js';
import type { MessageQueue } from './message-queue.js';
import { loadConfig } from '../utils/config.js';
import type { RemoteConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

export interface UserSessionBinding {
  openId: string;
  chatId: string;
  sessionToken: string;
  boundAt: number;
}

export interface FeishuMessageEvent {
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
    user_agent?: string;
  };
}

export interface FeishuCardActionEvent {
  open_id: string;
  token?: string;
  action?: {
    tag: string;
    value: Record<string, string>;
  };
  open_message_id?: string;
}

export class FeishuClient {
  private readonly router: SessionRouter;
  private readonly approval: ApprovalManager;
  private readonly messageQueue: MessageQueue;
  private readonly config: RemoteConfig;
  private readonly logger = createLogger('feishu');
  private readonly userBindings: Map<string, UserSessionBinding> = new Map();
  private onApprovalResolved?: (requestId: string, optionValue: string) => void;

  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private eventDispatcher: lark.EventDispatcher;
  private connected = false;

  /** Set callback for when approval is resolved via Feishu card button */
  setApprovalCallback(cb: (requestId: string, optionValue: string) => void): void {
    this.onApprovalResolved = cb;
  }

  constructor(router: SessionRouter, approval: ApprovalManager, messageQueue: MessageQueue, config?: RemoteConfig) {
    this.router = router;
    this.approval = approval;
    this.messageQueue = messageQueue;
    this.config = config ?? loadConfig();

    this.client = new lark.Client({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    this.eventDispatcher = new lark.EventDispatcher({});
  }

  async start(): Promise<void> {
    this.registerEventHandlers();

    this.wsClient = new lark.WSClient({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher,
    });

    // Monkey-patch WSClient to also handle card type messages (SDK drops them by default)
    this.patchWSClientForCardActions();

    this.connected = true;
    this.logger.info('Feishu WSClient connected');
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
    }
    this.connected = false;
    this.logger.info('Feishu WSClient stopped');
  }

  getConnected(): boolean {
    return this.connected;
  }

  async sendMessage(openId: string, content: string, msgType: 'text' | 'interactive' = 'text'): Promise<void> {
    const messageContent = msgType === 'text'
      ? JSON.stringify({ text: content })
      : content;

    await this.client.im.message.create({
      data: {
        receive_id: openId,
        msg_type: msgType,
        content: messageContent,
      },
      params: {
        receive_id_type: 'open_id',
      },
    });
  }

  async sendRichText(openId: string, title: string, body: string): Promise<void> {
    const content = JSON.stringify({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template: 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: body,
          },
        },
      ],
    });

    await this.sendMessage(openId, content, 'interactive');
  }

  async sendToolResult(openId: string, toolName: string, result: string): Promise<void> {
    const truncated = this.truncateContent(result, 3000);
    const body = `**Tool: ${toolName}**\n\`\`\`\n${truncated}\n\`\`\``;
    await this.sendRichText(openId, `Tool Result: ${toolName}`, body);
  }

  async sendApprovalCard(openId: string, request: ApprovalRequest): Promise<void> {
    const buttons = request.options.map(opt => ({
      tag: 'button',
      text: { tag: 'plain_text', content: opt.label },
      type: opt.style === 'danger' ? 'danger' : opt.style === 'primary' ? 'primary' : 'default',
      value: { requestId: request.requestId, optionId: opt.id, value: opt.value },
    }));

    const content = JSON.stringify({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `⚠️ 工具审批: ${request.type}` },
        template: 'orange',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: this.truncateContent(request.message, 3000),
          },
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: buttons,
        },
      ],
    });

    await this.sendMessage(openId, content, 'interactive');
  }

  async sendSessionList(openId: string, chatId: string): Promise<void> {
    const instances = this.router.getOnlineInstances();

    if (instances.length === 0) {
      await this.sendMessage(openId, 'No online sessions available.');
      return;
    }

    const elements: any[] = [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${instances.length} online session(s):**\n`,
        },
      },
    ];

    for (const inst of instances) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `• \`${inst.sessionId}\` - ${inst.workdir} (since ${new Date(inst.registeredAt).toLocaleString()})`,
        },
      });
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `Bind: ${inst.sessionId}` },
            type: 'primary',
            value: { action: 'bind', token: inst.token, chatId },
          },
        ],
      });
    }

    const content = JSON.stringify({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Session List' },
        template: 'blue',
      },
      elements,
    });

    await this.sendMessage(openId, content, 'interactive');
  }

  bindUserSession(openId: string, chatId: string, sessionToken: string): void {
    const key = `${openId}:${chatId}`;
    this.userBindings.set(key, {
      openId,
      chatId,
      sessionToken,
      boundAt: Date.now(),
    });
    this.logger.info({ openId, chatId, sessionToken }, 'User bound to session');
  }

  getBoundSession(openId: string, chatId: string): UserSessionBinding | undefined {
    return this.userBindings.get(`${openId}:${chatId}`);
  }

  getBoundUsersBySession(sessionToken: string): string[] {
    const openIds: string[] = [];
    for (const binding of this.userBindings.values()) {
      if (binding.sessionToken === sessionToken) {
        openIds.push(binding.openId);
      }
    }
    return openIds;
  }

  async handleCardAction(data: FeishuCardActionEvent): Promise<void> {
    const openId = data.open_id;

    // Whitelist check
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(openId)) {
      this.logger.warn({ openId }, 'Card action from unauthorized user');
      return;
    }

    const action = data.action;
    if (!action || !action.value) return;

    const { requestId, optionId, action: actionType, token, chatId } = action.value;

    // Approval response — resolve pending approval and notify Feishu user
    if (requestId) {
      const response = this.approval.respond(requestId, optionId);
      if (response) {
        // Also resolve the pending waitForApproval promise in bridge server
        if (this.onApprovalResolved) {
          this.onApprovalResolved(requestId, response.value);
        }
        const emoji = response.value === 'allow' ? '✅' : '❌';
        await this.sendMessage(openId, `${emoji} 已${response.value === 'allow' ? '允许' : '拒绝'}`);
      } else {
        await this.sendMessage(openId, '⚠️ 该审批请求已过期或已被处理');
      }
      return;
    }

    // Instance binding
    if (actionType === 'bind' && token && chatId) {
      const instance = this.router.getInstance(token);
      if (instance && instance.state === 'online') {
        this.bindUserSession(openId, chatId, token);
        await this.sendMessage(openId, `Bound to session: ${instance.sessionId} (${instance.workdir})`);
      } else {
        await this.sendMessage(openId, 'Session not found or offline.');
      }
    }
  }

  async handleMessage(data: FeishuMessageEvent): Promise<void> {
    const openId = data.sender.sender_id?.open_id;
    if (!openId) return;

    const chatId = data.message.chat_id;

    // Whitelist check
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(openId)) {
      this.logger.warn({ openId }, 'Message from unauthorized user');
      return;
    }

    // Only handle text messages
    if (data.message.message_type !== 'text') return;

    let text: string;
    try {
      const parsed = JSON.parse(data.message.content) as { text?: string };
      text = (parsed.text ?? '').trim();
    } catch {
      return;
    }

    if (!text) return;

    // Command routing
    if (text.startsWith('/')) {
      const parts = text.split(/\s+/);
      const command = parts[0].toLowerCase();

      switch (command) {
        case '/stop':
          await this.sendMessage(openId, 'Stop command received. (not yet implemented)');
          break;
        case '/clear':
          await this.sendMessage(openId, 'Clear command received. (not yet implemented)');
          break;
        case '/status': {
          const binding = this.getBoundSession(openId, chatId);
          if (binding) {
            const instance = this.router.getInstance(binding.sessionToken);
            await this.sendMessage(openId, `Bound session: ${instance ? instance.sessionId : 'unknown'}\nState: ${instance ? instance.state : 'not found'}`);
          } else {
            await this.sendMessage(openId, 'No bound session. Use /list to see available sessions.');
          }
          break;
        }
        case '/list':
          await this.sendSessionList(openId, chatId);
          break;
        case '/remote': {
          // Show session list for binding
          await this.sendSessionList(openId, chatId);
          break;
        }
        case '/unbind': {
          const binding = this.getBoundSession(openId, chatId);
          if (!binding) {
            await this.sendMessage(openId, '当前没有绑定任何会话。使用 /list 查看可用会话。');
            break;
          }
          const sessionToken = binding.sessionToken;
          const instance = this.router.getInstance(sessionToken);
          const sessionId = instance?.sessionId ?? 'unknown';
          const workdir = instance?.workdir ?? 'unknown';
          // Remove user binding
          this.userBindings.delete(`${openId}:${chatId}`);
          // Unregister session from router
          this.router.unregister(sessionToken);
          // Clean up approval requests
          if (instance) {
            this.approval.removeSessionRequests(instance.sessionId);
          }
          this.logger.info({ openId, sessionId }, 'User unbound and session unregistered via /unbind');
          await this.sendMessage(openId, `已断开会话: ${sessionId} (${workdir})`);
          break;
        }
        case '/bind': {
          // Text-based binding (workaround for card action callbacks not supported in WS mode)
          const targetSessionId = parts[1];
          if (!targetSessionId) {
            await this.sendSessionList(openId, chatId);
            break;
          }
          const instances = this.router.getOnlineInstances();
          const target = instances.find(i => i.sessionId === targetSessionId);
          if (target) {
            this.bindUserSession(openId, chatId, target.token);
            await this.sendMessage(openId, `Bound to session: ${target.sessionId} (${target.workdir})`);
          } else {
            await this.sendMessage(openId, `Session "${targetSessionId}" not found. Use /list to see available sessions.`);
          }
          break;
        }
        default:
          await this.sendMessage(openId, `Unknown command: ${command}`);
          break;
      }
      return;
    }

    // Non-command text: enqueue to bound session or show session list
    const binding = this.getBoundSession(openId, chatId);
    if (binding) {
      const instance = this.router.getInstance(binding.sessionToken);
      if (instance && instance.state === 'online') {
        this.messageQueue.enqueue(binding.sessionToken, text, openId);
        // Update heartbeat so session doesn't timeout while user is active on Feishu
        this.router.heartbeat(binding.sessionToken);
        this.logger.info({ openId, sessionId: instance.sessionId, text }, 'Message forwarded to session');
        await this.sendMessage(openId, '消息已送达 CC 会话');
      } else {
        await this.sendMessage(openId, 'Bound session is offline. Use /list to bind a new session.');
      }
    } else {
      await this.sendSessionList(openId, chatId);
    }
  }

  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;
    return content.slice(0, maxLength) + '...[truncated]';
  }

  private registerEventHandlers(): void {
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: FeishuMessageEvent) => {
        this.logger.info({ messageId: data.message.message_id }, 'Message received');
        await this.handleMessage(data);
      },
      'card.action.trigger': async (data: any) => {
        // New version: operator.open_id, context.open_chat_id; Old version: open_id
        const openId = data.operator?.open_id ?? data.open_id;
        const chatId = data.context?.open_chat_id;
        this.logger.info({ openId, chatId }, 'Card action received');
        await this.handleCardAction({ ...data, open_id: openId, chat_id: chatId });
      },
    });
  }

  /**
   * Monkey-patch WSClient to also dispatch card type messages.
   * The SDK's handleEventData drops MessageType.card messages by default.
   */
  private patchWSClientForCardActions(): void {
    const wsClient = this.wsClient as any;
    if (!wsClient) return;

    const originalHandleEventData = wsClient.handleEventData.bind(wsClient);
    const logger = this.logger;

    wsClient.handleEventData = async function (data: any) {
      // Check if this is a card type message
      const headers: Record<string, string> = {};
      if (data.headers) {
        for (const h of data.headers) {
          headers[h.key] = h.value;
        }
      }

      if (headers.type === 'card') {
        try {
          const payloadStr = new TextDecoder().decode(data.payload);
          const payload = JSON.parse(payloadStr);
          logger.info({ type: 'card', trace_id: headers.trace_id }, 'Card action received via WS');

          // Dispatch through event dispatcher
          if (wsClient.eventDispatcher) {
            const result = await wsClient.eventDispatcher.invoke(payload, { needCheck: false });
            // Send response back
            const respPayload = Buffer.from(JSON.stringify(result ?? {})).toString('base64');
            wsClient.sendMessage({
              ...data,
              headers: [...data.headers, { key: 'biz_rt', value: '0' }],
              payload: new TextEncoder().encode(JSON.stringify({ code: 200, data: respPayload })),
            });
          }
          return;
        } catch (err) {
          logger.error({ err }, 'Failed to handle card action');
        }
      }

      // Fall through to original handler for event type messages
      return originalHandleEventData(data);
    };
  }
}
