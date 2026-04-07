import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalManager } from '../bridge/approval.js';
import { SessionRouter, SessionState } from '../bridge/router.js';
import type { SessionInstance } from '../bridge/router.js';

const testConfig = {
  feishu: { appId: 'test', appSecret: 'test' },
  server: { port: 9876, host: '127.0.0.1' },
  allowedUsers: [],
  heartbeatInterval: 100,
  sessionTimeout: 500,
};

function createMockRouter(): SessionRouter {
  const router = new SessionRouter(testConfig);
  return router;
}

describe('ApprovalManager', () => {
  let router: SessionRouter;
  let approval: ApprovalManager;

  beforeEach(() => {
    vi.useFakeTimers();
    router = createMockRouter();
    approval = new ApprovalManager(router, testConfig);
  });

  afterEach(() => {
    approval.destroy();
    router.destroy();
    vi.useRealTimers();
  });

  it('enqueue() creates request with createdAt and timeoutMs', () => {
    const req = approval.enqueue({
      type: 'PreToolUse',
      sessionId: 'sess-1',
      requestId: 'req-1',
      message: 'Allow Bash?',
      options: [
        { id: 'allow', label: '允许', style: 'primary', value: 'allow' },
        { id: 'deny', label: '拒绝', style: 'danger', value: 'deny' },
      ],
    });
    expect(req.createdAt).toBeTypeOf('number');
    expect(req.timeoutMs).toBe(500);
    expect(req.requestId).toBe('req-1');
  });

  it('enqueue() shows in getPendingRequests()', () => {
    approval.enqueue({
      type: 'PreToolUse',
      sessionId: 'sess-1',
      requestId: 'req-1',
      message: 'Allow?',
      options: [{ id: 'allow', label: '允许', style: 'primary', value: 'allow' }],
    });
    const pending = approval.getPendingRequests('sess-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe('req-1');
  });

  it('respond() with valid requestId and optionId returns response', () => {
    approval.enqueue({
      type: 'PreToolUse',
      sessionId: 'sess-1',
      requestId: 'req-1',
      message: 'Allow?',
      options: [{ id: 'allow', label: '允许', style: 'primary', value: 'allow' }],
    });
    const resp = approval.respond('req-1', 'allow');
    expect(resp).not.toBeNull();
    expect(resp!.value).toBe('allow');
    expect(resp!.requestId).toBe('req-1');
  });

  it('respond() moves request from queue to responses', () => {
    approval.enqueue({
      type: 'PreToolUse',
      sessionId: 'sess-1',
      requestId: 'req-1',
      message: 'Allow?',
      options: [{ id: 'allow', label: '允许', style: 'primary', value: 'allow' }],
    });
    approval.respond('req-1', 'allow');
    expect(approval.getRequest('req-1')).toBeUndefined();
    expect(approval.getResponse('req-1')).not.toBeNull();
  });

  it('respond() with invalid requestId returns null', () => {
    expect(approval.respond('invalid', 'allow')).toBeNull();
  });

  it('respond() with invalid optionId returns null', () => {
    approval.enqueue({
      type: 'PreToolUse',
      sessionId: 'sess-1',
      requestId: 'req-1',
      message: 'Allow?',
      options: [{ id: 'allow', label: '允许', style: 'primary', value: 'allow' }],
    });
    expect(approval.respond('req-1', 'nonexistent')).toBeNull();
  });

  it('request times out and is removed from queue', () => {
    approval.enqueue({
      type: 'PreToolUse',
      sessionId: 'sess-1',
      requestId: 'req-1',
      message: 'Allow?',
      options: [{ id: 'allow', label: '允许', style: 'primary', value: 'allow' }],
    });
    vi.advanceTimersByTime(600);
    expect(approval.getRequest('req-1')).toBeUndefined();
  });

  it('respond() clears timeout timer', () => {
    approval.enqueue({
      type: 'PreToolUse',
      sessionId: 'sess-1',
      requestId: 'req-1',
      message: 'Allow?',
      options: [{ id: 'allow', label: '允许', style: 'primary', value: 'allow' }],
    });
    approval.respond('req-1', 'allow');
    // Advance past timeout - response should still exist (timer was cleared)
    vi.advanceTimersByTime(600);
    expect(approval.getResponse('req-1')).not.toBeNull();
  });

  it('removeSessionRequests() clears requests for a session', () => {
    approval.enqueue({
      type: 'PreToolUse',
      sessionId: 'sess-1',
      requestId: 'req-1',
      message: 'Allow?',
      options: [{ id: 'allow', label: '允许', style: 'primary', value: 'allow' }],
    });
    approval.enqueue({
      type: 'PreToolUse',
      sessionId: 'sess-2',
      requestId: 'req-2',
      message: 'Allow?',
      options: [{ id: 'allow', label: '允许', style: 'primary', value: 'allow' }],
    });
    approval.removeSessionRequests('sess-1');
    expect(approval.getRequest('req-1')).toBeUndefined();
    expect(approval.getRequest('req-2')).toBeDefined();
  });

  it('destroy() clears all requests, responses, and timers', () => {
    approval.enqueue({
      type: 'PreToolUse',
      sessionId: 'sess-1',
      requestId: 'req-1',
      message: 'Allow?',
      options: [{ id: 'allow', label: '允许', style: 'primary', value: 'allow' }],
    });
    approval.destroy();
    expect(approval.getRequest('req-1')).toBeUndefined();
  });

  it('multiple requests timeout independently', () => {
    approval.enqueue({
      type: 'PreToolUse',
      sessionId: 'sess-1',
      requestId: 'req-1',
      message: 'Allow?',
      options: [{ id: 'allow', label: '允许', style: 'primary', value: 'allow' }],
    });
    vi.advanceTimersByTime(200);
    approval.enqueue({
      type: 'PreToolUse',
      sessionId: 'sess-1',
      requestId: 'req-2',
      message: 'Allow?',
      options: [{ id: 'allow', label: '允许', style: 'primary', value: 'allow' }],
    });
    // Advance past first request timeout but not second
    vi.advanceTimersByTime(400);
    expect(approval.getRequest('req-1')).toBeUndefined();
    expect(approval.getRequest('req-2')).toBeDefined();
  });
});
