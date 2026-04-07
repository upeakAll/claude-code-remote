import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { FeishuClient } from '../bridge/feishu-client.js';
import type { FeishuMessageEvent, FeishuCardActionEvent } from '../bridge/feishu-client.js';
import { SessionRouter, SessionState } from '../bridge/router.js';
import { ApprovalManager } from '../bridge/approval.js';
import { MessageQueue } from '../bridge/message-queue.js';
import type { RemoteConfig } from '../utils/config.js';

// --- Mock @larksuiteoapi/node-sdk ---
const mockWsStart = vi.fn().mockResolvedValue(undefined);
const mockWsClose = vi.fn();

vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    WSClient: vi.fn().mockImplementation(() => ({
      start: mockWsStart,
      close: mockWsClose,
      handleEventData: vi.fn(),
    })),
    Client: vi.fn().mockImplementation(() => ({
      im: {
        message: {
          create: vi.fn().mockResolvedValue({ code: 0 }),
        },
      },
    })),
    EventDispatcher: vi.fn().mockImplementation(() => ({
      register: vi.fn(),
    })),
    LoggerLevel: { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
  };
});

const testConfig: RemoteConfig = {
  feishu: { appId: 'test-app-id', appSecret: 'test-app-secret' },
  server: { port: 9876, host: '127.0.0.1' },
  allowedUsers: ['ou_user_allowed'],
  heartbeatInterval: 10000,
  sessionTimeout: 60000,
};

function createTestClient(overrides?: Partial<RemoteConfig>): FeishuClient {
  const config = { ...testConfig, ...overrides };
  const router = new SessionRouter(config);
  const approval = new ApprovalManager(router, config);
  const messageQueue = new MessageQueue();
  return new FeishuClient(router, approval, messageQueue, config);
}

function makeMessageEvent(openId: string, text: string, chatId = 'oc_test_chat'): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { open_id: openId },
      sender_type: 'user',
      tenant_key: 'tenant',
    },
    message: {
      message_id: 'msg_123',
      create_time: String(Date.now()),
      chat_id: chatId,
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
}

function makeCardActionEvent(
  openId: string,
  value: Record<string, string>,
): FeishuCardActionEvent {
  return {
    open_id: openId,
    action: {
      tag: 'button',
      value,
    },
  };
}

// --- Tests ---

describe('FeishuClient', () => {
  let client: FeishuClient;
  let router: SessionRouter;
  let approval: ApprovalManager;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new SessionRouter(testConfig);
    approval = new ApprovalManager(router, testConfig);
    const messageQueue = new MessageQueue();
    client = new FeishuClient(router, approval, messageQueue, testConfig);
  });

  describe('constructor', () => {
    it('creates a FeishuClient instance', () => {
      expect(client).toBeInstanceOf(FeishuClient);
    });

    it('initializes not connected', () => {
      expect(client.getConnected()).toBe(false);
    });
  });

  describe('start / stop', () => {
    it('start() connects via WSClient', async () => {
      await client.start();
      expect(mockWsStart).toHaveBeenCalledTimes(1);
      expect(client.getConnected()).toBe(true);
    });

    it('stop() disconnects and sets connected to false', async () => {
      await client.start();
      await client.stop();
      expect(mockWsClose).toHaveBeenCalledTimes(1);
      expect(client.getConnected()).toBe(false);
    });

    it('stop() without start is safe', async () => {
      await client.stop();
      expect(mockWsClose).not.toHaveBeenCalled();
      expect(client.getConnected()).toBe(false);
    });
  });

  describe('bindUserSession / getBoundSession / getBoundUsersBySession', () => {
    it('binds and retrieves a session', () => {
      client.bindUserSession('ou_1', 'oc_1', 'token_abc');
      const binding = client.getBoundSession('ou_1', 'oc_1');
      expect(binding).toBeDefined();
      expect(binding!.sessionToken).toBe('token_abc');
      expect(binding!.openId).toBe('ou_1');
      expect(binding!.chatId).toBe('oc_1');
      expect(binding!.boundAt).toBeTypeOf('number');
    });

    it('returns undefined for unbound user/chat combo', () => {
      expect(client.getBoundSession('ou_1', 'oc_1')).toBeUndefined();
    });

    it('different chatId yields different binding', () => {
      client.bindUserSession('ou_1', 'oc_1', 'token_abc');
      client.bindUserSession('ou_1', 'oc_2', 'token_def');
      expect(client.getBoundSession('ou_1', 'oc_1')!.sessionToken).toBe('token_abc');
      expect(client.getBoundSession('ou_1', 'oc_2')!.sessionToken).toBe('token_def');
    });

    it('getBoundUsersBySession returns openId list', () => {
      client.bindUserSession('ou_1', 'oc_1', 'token_abc');
      client.bindUserSession('ou_2', 'oc_1', 'token_abc');
      client.bindUserSession('ou_3', 'oc_1', 'token_def');

      const users = client.getBoundUsersBySession('token_abc');
      expect(users).toContain('ou_1');
      expect(users).toContain('ou_2');
      expect(users).toHaveLength(2);
    });

    it('getBoundUsersBySession returns empty for unknown token', () => {
      expect(client.getBoundUsersBySession('nonexistent')).toEqual([]);
    });

    it('overwrites binding on rebind', () => {
      client.bindUserSession('ou_1', 'oc_1', 'token_abc');
      client.bindUserSession('ou_1', 'oc_1', 'token_def');
      expect(client.getBoundSession('ou_1', 'oc_1')!.sessionToken).toBe('token_def');
    });
  });

  describe('handleMessage - whitelist check', () => {
    it('ignores messages from unauthorized users', async () => {
      const clientAny = createTestClient({ allowedUsers: ['ou_allowed'] } as any);
      const sendMessageSpy = vi.spyOn(clientAny as any, 'sendMessage');
      const event = makeMessageEvent('ou_unauthorized', 'hello');
      await clientAny.handleMessage(event);
      expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    it('processes messages from allowed users', async () => {
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeMessageEvent('ou_user_allowed', '/status');
      await client.handleMessage(event);
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    });

    it('allows all users when allowedUsers is empty', async () => {
      const openConfig = { ...testConfig, allowedUsers: [] as string[] };
      const openRouter = new SessionRouter(openConfig);
      const openApproval = new ApprovalManager(openRouter, openConfig);
      const openMessageQueue = new MessageQueue();
      const openClient = new FeishuClient(openRouter, openApproval, openMessageQueue, openConfig);
      const sendMessageSpy = vi.spyOn(openClient as any, 'sendMessage');
      const event = makeMessageEvent('ou_anyone', '/status');
      await openClient.handleMessage(event);
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleMessage - command routing', () => {
    it('/status shows bound session info', async () => {
      const { token } = router.register('session-1', '/tmp/work');
      client.bindUserSession('ou_user_allowed', 'oc_test_chat', token);

      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeMessageEvent('ou_user_allowed', '/status');
      await client.handleMessage(event);

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const callArgs = sendMessageSpy.mock.calls[0];
      expect(callArgs[1]).toContain('Bound session');
    });

    it('/status with no binding shows hint', async () => {
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeMessageEvent('ou_user_allowed', '/status');
      await client.handleMessage(event);

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const callArgs = sendMessageSpy.mock.calls[0];
      expect(callArgs[1]).toContain('No bound session');
    });

    it('/list triggers sendSessionList', async () => {
      const sendSessionListSpy = vi.spyOn(client as any, 'sendSessionList');
      const event = makeMessageEvent('ou_user_allowed', '/list');
      await client.handleMessage(event);
      expect(sendSessionListSpy).toHaveBeenCalledTimes(1);
    });

    it('/remote triggers sendSessionList', async () => {
      const sendSessionListSpy = vi.spyOn(client as any, 'sendSessionList');
      const event = makeMessageEvent('ou_user_allowed', '/remote');
      await client.handleMessage(event);
      expect(sendSessionListSpy).toHaveBeenCalledTimes(1);
    });

    it('/stop returns acknowledged message', async () => {
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeMessageEvent('ou_user_allowed', '/stop');
      await client.handleMessage(event);
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const callArgs = sendMessageSpy.mock.calls[0];
      expect(callArgs[1]).toContain('Stop command');
    });

    it('/clear returns acknowledged message', async () => {
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeMessageEvent('ou_user_allowed', '/clear');
      await client.handleMessage(event);
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const callArgs = sendMessageSpy.mock.calls[0];
      expect(callArgs[1]).toContain('Clear command');
    });

    it('unknown command returns unknown message', async () => {
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeMessageEvent('ou_user_allowed', '/foobar');
      await client.handleMessage(event);
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const callArgs = sendMessageSpy.mock.calls[0];
      expect(callArgs[1]).toContain('Unknown command');
    });
  });

  describe('handleMessage - non-command text', () => {
    it('enqueues message to bound session', async () => {
      const { token } = router.register('session-1', '/tmp/work');
      client.bindUserSession('ou_user_allowed', 'oc_test_chat', token);

      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeMessageEvent('ou_user_allowed', 'hello world');
      await client.handleMessage(event);

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const callArgs = sendMessageSpy.mock.calls[0];
      expect(callArgs[1]).toContain('消息已送达 CC 会话');

      // Verify message is enqueued
      const mq = (client as any).messageQueue as MessageQueue;
      expect(mq.hasPending(token)).toBe(true);
      const messages = mq.dequeue(token);
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('hello world');
      expect(messages[0].openId).toBe('ou_user_allowed');
    });

    it('enqueues multiple messages in order', async () => {
      const { token } = router.register('session-1', '/tmp/work');
      client.bindUserSession('ou_user_allowed', 'oc_test_chat', token);

      await client.handleMessage(makeMessageEvent('ou_user_allowed', 'msg1'));
      await client.handleMessage(makeMessageEvent('ou_user_allowed', 'msg2'));
      await client.handleMessage(makeMessageEvent('ou_user_allowed', 'msg3'));

      const mq = (client as any).messageQueue as MessageQueue;
      const messages = mq.dequeue(token);
      expect(messages).toHaveLength(3);
      expect(messages[0].text).toBe('msg1');
      expect(messages[1].text).toBe('msg2');
      expect(messages[2].text).toBe('msg3');
    });

    it('shows session list when not bound', async () => {
      const sendSessionListSpy = vi.spyOn(client as any, 'sendSessionList');
      const event = makeMessageEvent('ou_user_allowed', 'hello world');
      await client.handleMessage(event);
      expect(sendSessionListSpy).toHaveBeenCalledTimes(1);
    });

    it('shows offline message when bound session is gone', async () => {
      client.bindUserSession('ou_user_allowed', 'oc_test_chat', 'nonexistent_token');
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeMessageEvent('ou_user_allowed', 'hello');
      await client.handleMessage(event);

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const callArgs = sendMessageSpy.mock.calls[0];
      expect(callArgs[1]).toContain('offline');
    });
  });

  describe('handleMessage - edge cases', () => {
    it('ignores empty text', async () => {
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeMessageEvent('ou_user_allowed', '   ');
      await client.handleMessage(event);
      expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    it('ignores non-text message types', async () => {
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event: FeishuMessageEvent = {
        sender: {
          sender_id: { open_id: 'ou_user_allowed' },
          sender_type: 'user',
        },
        message: {
          message_id: 'msg_123',
          create_time: String(Date.now()),
          chat_id: 'oc_test_chat',
          chat_type: 'p2p',
          message_type: 'image',
          content: '{}',
        },
      };
      await client.handleMessage(event);
      expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    it('ignores messages without open_id', async () => {
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event: FeishuMessageEvent = {
        sender: {
          sender_id: {},
          sender_type: 'user',
        },
        message: {
          message_id: 'msg_123',
          create_time: String(Date.now()),
          chat_id: 'oc_test_chat',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
      };
      await client.handleMessage(event);
      expect(sendMessageSpy).not.toHaveBeenCalled();
    });
  });

  describe('handleCardAction - approval response', () => {
    it('responds to an approval request', async () => {
      const { token } = router.register('session-1', '/tmp/work');
      const instance = router.getInstance(token)!;
      const request = approval.enqueue({
        type: 'PreToolUse',
        sessionId: instance.sessionId,
        requestId: 'req-001',
        message: 'Allow Bash?',
        options: [
          { id: 'allow', label: 'Allow', style: 'primary', value: 'allow' },
          { id: 'deny', label: 'Deny', style: 'danger', value: 'deny' },
        ],
      });

      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeCardActionEvent('ou_user_allowed', {
        requestId: request.requestId,
        optionId: 'allow',
      });
      await client.handleCardAction(event);

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const response = approval.getResponse(request.requestId);
      expect(response).toBeDefined();
      expect(response!.value).toBe('allow');
    });

    it('handles missing approval request', async () => {
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeCardActionEvent('ou_user_allowed', {
        requestId: 'nonexistent',
        optionId: 'allow',
      });
      await client.handleCardAction(event);

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const callArgs = sendMessageSpy.mock.calls[0];
      expect(callArgs[1]).toContain('not found');
    });
  });

  describe('handleCardAction - instance binding', () => {
    it('binds a session from card action', async () => {
      const { token } = router.register('session-1', '/tmp/work');

      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeCardActionEvent('ou_user_allowed', {
        action: 'bind',
        token,
        chatId: 'oc_chat_1',
      });
      await client.handleCardAction(event);

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const binding = client.getBoundSession('ou_user_allowed', 'oc_chat_1');
      expect(binding).toBeDefined();
      expect(binding!.sessionToken).toBe(token);
    });

    it('handles offline/unknown session binding', async () => {
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event = makeCardActionEvent('ou_user_allowed', {
        action: 'bind',
        token: 'nonexistent_token',
        chatId: 'oc_chat_1',
      });
      await client.handleCardAction(event);

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const callArgs = sendMessageSpy.mock.calls[0];
      expect(callArgs[1]).toContain('not found');
    });
  });

  describe('handleCardAction - whitelist check', () => {
    it('ignores card actions from unauthorized users', async () => {
      const clientAny = createTestClient({ allowedUsers: ['ou_allowed'] } as any);
      const sendMessageSpy = vi.spyOn(clientAny as any, 'sendMessage');
      const event = makeCardActionEvent('ou_unauthorized', {
        action: 'bind',
        token: 'token_123',
        chatId: 'oc_chat_1',
      });
      await clientAny.handleCardAction(event);
      expect(sendMessageSpy).not.toHaveBeenCalled();
    });
  });

  describe('handleCardAction - edge cases', () => {
    it('ignores card action without action data', async () => {
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      const event: FeishuCardActionEvent = {
        open_id: 'ou_user_allowed',
      };
      await client.handleCardAction(event);
      expect(sendMessageSpy).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage (mock Lark.Client)', () => {
    it('sends a text message', async () => {
      await client.start();
      const larkClient = (client as any).client;
      const createMock = larkClient.im.message.create as Mock;

      await client.sendMessage('ou_test', 'hello');

      expect(createMock).toHaveBeenCalledTimes(1);
      const call = createMock.mock.calls[0][0];
      expect(call.data.receive_id).toBe('ou_test');
      expect(call.data.msg_type).toBe('text');
      expect(call.params.receive_id_type).toBe('open_id');
      const parsed = JSON.parse(call.data.content);
      expect(parsed.text).toBe('hello');
    });

    it('sends an interactive message', async () => {
      await client.start();
      const larkClient = (client as any).client;
      const createMock = larkClient.im.message.create as Mock;

      await client.sendMessage('ou_test', '{"config":{}}', 'interactive');

      expect(createMock).toHaveBeenCalledTimes(1);
      const call = createMock.mock.calls[0][0];
      expect(call.data.msg_type).toBe('interactive');
      expect(call.data.content).toBe('{"config":{}}');
    });
  });

  describe('sendRichText', () => {
    it('sends a rich text card message', async () => {
      await client.start();
      const larkClient = (client as any).client;
      const createMock = larkClient.im.message.create as Mock;

      await client.sendRichText('ou_test', 'Title', '**bold** text');

      expect(createMock).toHaveBeenCalledTimes(1);
      const call = createMock.mock.calls[0][0];
      expect(call.data.msg_type).toBe('interactive');
      const parsed = JSON.parse(call.data.content);
      expect(parsed.header.title.content).toBe('Title');
      expect(parsed.elements[0].text.content).toBe('**bold** text');
    });
  });

  describe('sendToolResult', () => {
    it('sends a tool result card', async () => {
      await client.start();
      const larkClient = (client as any).client;
      const createMock = larkClient.im.message.create as Mock;

      await client.sendToolResult('ou_test', 'Bash', 'output result');

      expect(createMock).toHaveBeenCalledTimes(1);
      const call = createMock.mock.calls[0][0];
      expect(call.data.msg_type).toBe('interactive');
      const parsed = JSON.parse(call.data.content);
      expect(parsed.header.title.content).toContain('Tool Result');
    });
  });

  describe('sendApprovalCard', () => {
    it('sends an approval card with buttons', async () => {
      await client.start();
      const larkClient = (client as any).client;
      const createMock = larkClient.im.message.create as Mock;

      const request = approval.enqueue({
        type: 'PreToolUse',
        sessionId: 'session-1',
        requestId: 'req-002',
        message: 'Allow tool?',
        options: [
          { id: 'allow', label: 'Allow', style: 'primary', value: 'allow' },
          { id: 'deny', label: 'Deny', style: 'danger', value: 'deny' },
        ],
      });

      await client.sendApprovalCard('ou_test', request);

      expect(createMock).toHaveBeenCalledTimes(1);
      const call = createMock.mock.calls[0][0];
      expect(call.data.msg_type).toBe('interactive');
      const parsed = JSON.parse(call.data.content);
      expect(parsed.header.title.content).toContain('Approval');
      expect(parsed.elements[1].actions).toHaveLength(2);
    });
  });

  describe('sendSessionList', () => {
    it('sends "no sessions" when none online', async () => {
      const sendMessageSpy = vi.spyOn(client as any, 'sendMessage');
      await client.sendSessionList('ou_test', 'oc_chat');
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const callArgs = sendMessageSpy.mock.calls[0];
      expect(callArgs[1]).toContain('No online sessions');
    });

    it('sends a card with bind buttons for online sessions', async () => {
      const { token } = router.register('session-1', '/tmp/work');
      router.register('session-2', '/tmp/other');

      await client.start();
      const larkClient = (client as any).client;
      const createMock = larkClient.im.message.create as Mock;

      await client.sendSessionList('ou_test', 'oc_chat');

      expect(createMock).toHaveBeenCalledTimes(1);
      const call = createMock.mock.calls[0][0];
      const parsed = JSON.parse(call.data.content);
      // Should have header + 2 session divs + 2 action rows = 5 elements
      expect(parsed.elements.length).toBeGreaterThanOrEqual(4);
    });
  });
});
