import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookHandler } from '../hooks/hook-handler.js';
import type { HookPayload } from '../hooks/hook-handler.js';
import { SessionRouter, SessionState } from '../bridge/router.js';
import { ApprovalManager } from '../bridge/approval.js';
import type { FeishuClient } from '../bridge/feishu-client.js';
import type { ApprovalRequest } from '../bridge/approval.js';
import { MessageQueue } from '../bridge/message-queue.js';

const testConfig = {
  feishu: { appId: 'test', appSecret: 'test' },
  server: { port: 9876, host: '127.0.0.1' },
  allowedUsers: [],
  heartbeatInterval: 100,
  sessionTimeout: 500,
};

function createMockFeishuClient() {
  return {
    getBoundUsersBySession: vi.fn<string[], [string]>().mockReturnValue(['ou_user1']),
    sendApprovalCard: vi.fn<Promise<void>, [string, ApprovalRequest]>().mockResolvedValue(undefined),
    sendToolResult: vi.fn<Promise<void>, [string, string, string]>().mockResolvedValue(undefined),
    sendRichText: vi.fn<Promise<void>, [string, string, string]>().mockResolvedValue(undefined),
  } as unknown as FeishuClient;
}

describe('HookHandler', () => {
  let router: SessionRouter;
  let approval: ApprovalManager;
  let feishuClient: FeishuClient;
  let handler: HookHandler;
  let sessionToken: string;
  let messageQueue: MessageQueue;

  beforeEach(() => {
    router = new SessionRouter(testConfig);
    approval = new ApprovalManager(router, testConfig);
    feishuClient = createMockFeishuClient();
    messageQueue = new MessageQueue();
    handler = new HookHandler(router, approval, feishuClient, messageQueue);

    const result = router.register('sess-1', '/tmp/test');
    sessionToken = result.token;
  });

  describe('handle()', () => {
    it('returns error for unknown session token', async () => {
      const payload: HookPayload = {
        type: 'PreToolUse',
        session_id: 'sess-1',
        content: 'test',
      };
      const result = await handler.handle(payload, 'invalid-token');
      expect(result).toEqual({ status: 'error', message: 'Session not found' });
    });

    it('returns error when session is not online', async () => {
      const instance = router.getInstance(sessionToken)!;
      instance.state = SessionState.Disconnected;

      const payload: HookPayload = {
        type: 'PreToolUse',
        session_id: 'sess-1',
        content: 'test',
      };
      const result = await handler.handle(payload, sessionToken);
      expect(result).toEqual({ status: 'error', message: 'Session is not online' });
    });
  });

  describe('handlePreToolUse', () => {
    it('returns ok when approval is not needed', async () => {
      const payload: HookPayload = {
        type: 'PreToolUse',
        session_id: 'sess-1',
        content: 'doing something',
        tool_name: 'Read',
        approval_needed: false,
      };
      const result = await handler.handle(payload, sessionToken);
      expect(result).toEqual({ status: 'ok' });
      expect(feishuClient.sendApprovalCard).not.toHaveBeenCalled();
    });

    it('enqueues approval and sends card when approval_needed is true', async () => {
      const payload: HookPayload = {
        type: 'PreToolUse',
        session_id: 'sess-1',
        request_id: 'req-123',
        content: 'rm -rf /',
        tool_name: 'Bash',
        approval_needed: true,
      };
      const result = await handler.handle(payload, sessionToken);

      expect(result.status).toBe('approval_pending');
      if (result.status === 'approval_pending') {
        expect(result.request_id).toBe('req-123');
      }

      expect(approval.getRequest('req-123')).toBeDefined();
      expect(feishuClient.getBoundUsersBySession).toHaveBeenCalledWith(sessionToken);
      expect(feishuClient.sendApprovalCard).toHaveBeenCalledTimes(1);
      expect(feishuClient.sendApprovalCard).toHaveBeenCalledWith(
        'ou_user1',
        expect.objectContaining({ requestId: 'req-123' })
      );
    });

    it('generates a request_id if not provided', async () => {
      const payload: HookPayload = {
        type: 'PreToolUse',
        session_id: 'sess-1',
        content: 'rm -rf /',
        tool_name: 'Bash',
        approval_needed: true,
      };
      const result = await handler.handle(payload, sessionToken);

      expect(result.status).toBe('approval_pending');
      if (result.status === 'approval_pending') {
        expect(result.request_id).toBeTruthy();
        expect(approval.getRequest(result.request_id)).toBeDefined();
      }
    });

    it('sends approval card to all bound users', async () => {
      (feishuClient.getBoundUsersBySession as ReturnType<typeof vi.fn>).mockReturnValue([
        'ou_user1',
        'ou_user2',
      ]);

      const payload: HookPayload = {
        type: 'PreToolUse',
        session_id: 'sess-1',
        request_id: 'req-multi',
        content: 'dangerous',
        tool_name: 'Bash',
        approval_needed: true,
      };
      await handler.handle(payload, sessionToken);

      expect(feishuClient.sendApprovalCard).toHaveBeenCalledTimes(2);
      expect(feishuClient.sendApprovalCard).toHaveBeenCalledWith(
        'ou_user1',
        expect.objectContaining({ requestId: 'req-multi' })
      );
      expect(feishuClient.sendApprovalCard).toHaveBeenCalledWith(
        'ou_user2',
        expect.objectContaining({ requestId: 'req-multi' })
      );
    });

    it('continues even if sending to one user fails', async () => {
      (feishuClient.getBoundUsersBySession as ReturnType<typeof vi.fn>).mockReturnValue([
        'ou_user1',
        'ou_user2',
      ]);
      (feishuClient.sendApprovalCard as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(undefined);

      const payload: HookPayload = {
        type: 'PreToolUse',
        session_id: 'sess-1',
        request_id: 'req-fail',
        content: 'dangerous',
        tool_name: 'Bash',
        approval_needed: true,
      };
      const result = await handler.handle(payload, sessionToken);

      expect(result.status).toBe('approval_pending');
      expect(feishuClient.sendApprovalCard).toHaveBeenCalledTimes(2);
    });
  });

  describe('handlePostToolUse', () => {
    it('sends tool result to bound users', async () => {
      const payload: HookPayload = {
        type: 'PostToolUse',
        session_id: 'sess-1',
        content: 'file contents here',
        tool_name: 'Read',
      };
      const result = await handler.handle(payload, sessionToken);

      expect(result).toEqual({ status: 'ok' });
      expect(feishuClient.sendToolResult).toHaveBeenCalledWith(
        'ou_user1',
        'Read',
        'file contents here'
      );
    });

    it('uses "unknown" when tool_name is not provided', async () => {
      const payload: HookPayload = {
        type: 'PostToolUse',
        session_id: 'sess-1',
        content: 'some result',
      };
      await handler.handle(payload, sessionToken);

      expect(feishuClient.sendToolResult).toHaveBeenCalledWith(
        'ou_user1',
        'unknown',
        'some result'
      );
    });

    it('sends to all bound users', async () => {
      (feishuClient.getBoundUsersBySession as ReturnType<typeof vi.fn>).mockReturnValue([
        'ou_user1',
        'ou_user2',
      ]);

      const payload: HookPayload = {
        type: 'PostToolUse',
        session_id: 'sess-1',
        content: 'result',
        tool_name: 'Bash',
      };
      await handler.handle(payload, sessionToken);

      expect(feishuClient.sendToolResult).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleNotification', () => {
    it('sends rich text to bound users', async () => {
      const payload: HookPayload = {
        type: 'Notification',
        session_id: 'sess-1',
        content: 'Task completed successfully',
      };
      const result = await handler.handle(payload, sessionToken);

      expect(result).toEqual({ status: 'ok' });
      expect(feishuClient.sendRichText).toHaveBeenCalledWith(
        'ou_user1',
        'Notification',
        'Task completed successfully'
      );
    });

    it('sends to all bound users', async () => {
      (feishuClient.getBoundUsersBySession as ReturnType<typeof vi.fn>).mockReturnValue([
        'ou_user1',
        'ou_user2',
      ]);

      const payload: HookPayload = {
        type: 'Notification',
        session_id: 'sess-1',
        content: 'Done',
      };
      await handler.handle(payload, sessionToken);

      expect(feishuClient.sendRichText).toHaveBeenCalledTimes(2);
    });

    it('continues even if sending to one user fails', async () => {
      (feishuClient.getBoundUsersBySession as ReturnType<typeof vi.fn>).mockReturnValue([
        'ou_user1',
        'ou_user2',
      ]);
      (feishuClient.sendRichText as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(undefined);

      const payload: HookPayload = {
        type: 'Notification',
        session_id: 'sess-1',
        content: 'Done',
      };
      const result = await handler.handle(payload, sessionToken);

      expect(result).toEqual({ status: 'ok' });
      expect(feishuClient.sendRichText).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleStop', () => {
    it('returns decision approve when no pending messages', async () => {
      const payload: HookPayload = {
        type: 'Stop',
        session_id: 'sess-1',
        content: '',
      };
      const result = await handler.handle(payload, sessionToken);
      expect(result).toEqual({ decision: 'approve' });
    });

    it('returns block when pending messages exist', async () => {
      messageQueue.enqueue(sessionToken, 'hello', 'ou_user');
      const payload: HookPayload = {
        type: 'Stop',
        session_id: 'sess-1',
        content: '',
      };
      const result = await handler.handle(payload, sessionToken);
      expect(result).toEqual({
        decision: 'block',
        reason: '飞书远程消息:\n[1] hello',
        systemMessage: '飞书远程消息:\n[1] hello',
      });
    });

    it('formats multiple messages', async () => {
      messageQueue.enqueue(sessionToken, 'msg1', 'ou_user');
      messageQueue.enqueue(sessionToken, 'msg2', 'ou_user');
      messageQueue.enqueue(sessionToken, 'msg3', 'ou_user');
      const payload: HookPayload = {
        type: 'Stop',
        session_id: 'sess-1',
        content: '',
      };
      const result = await handler.handle(payload, sessionToken);
      if (result.decision === 'block') {
        expect(result.reason).toContain('[1] msg1');
        expect(result.reason).toContain('[2] msg2');
        expect(result.reason).toContain('[3] msg3');
      }
    });

    it('dequeues messages after block, subsequent stop approves', async () => {
      messageQueue.enqueue(sessionToken, 'msg1', 'ou_user');
      messageQueue.enqueue(sessionToken, 'msg2', 'ou_user');
      const payload: HookPayload = {
        type: 'Stop',
        session_id: 'sess-1',
        content: '',
      };
      const first = await handler.handle(payload, sessionToken);
      expect(first.decision).toBe('block');
      const second = await handler.handle(payload, sessionToken);
      expect(second).toEqual({ decision: 'approve' });
    });

    it('does not send Feishu messages', async () => {
      const payload: HookPayload = {
        type: 'Stop',
        session_id: 'sess-1',
        content: '',
      };
      await handler.handle(payload, sessionToken);
      expect(feishuClient.getBoundUsersBySession).not.toHaveBeenCalled();
    });
  });

  describe('formatApprovalMessage', () => {
    it('formats message with tool name and content', () => {
      const payload: HookPayload = {
        type: 'PreToolUse',
        session_id: 'sess-1',
        content: 'rm -rf /',
        tool_name: 'Bash',
        approval_needed: true,
      };
      const message = handler.formatApprovalMessage(payload);

      expect(message).toContain('**Tool Approval Required**');
      expect(message).toContain('Tool: `Bash`');
      expect(message).toContain('rm -rf /');
    });

    it('uses "unknown" when tool_name is not provided', () => {
      const payload: HookPayload = {
        type: 'PreToolUse',
        session_id: 'sess-1',
        content: 'do something',
      };
      const message = handler.formatApprovalMessage(payload);
      expect(message).toContain('Tool: `unknown`');
    });
  });
});
