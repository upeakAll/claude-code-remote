import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionRouter, SessionState } from '../bridge/router.js';

const testConfig = {
  feishu: { appId: 'test', appSecret: 'test' },
  server: { port: 9876, host: '127.0.0.1' },
  allowedUsers: [],
  heartbeatInterval: 100,
  sessionTimeout: 500,
};

describe('SessionRouter', () => {
  let router: SessionRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    router = new SessionRouter(testConfig);
  });

  afterEach(() => {
    router.destroy();
    vi.useRealTimers();
  });

  it('register() returns token (64-char hex)', () => {
    const result = router.register('sess-1', '/tmp/test');
    expect(result.token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(result.token)).toBe(true);
  });

  it('register() creates instance with Online state', () => {
    const { token } = router.register('sess-1', '/tmp/test');
    const inst = router.getInstance(token);
    expect(inst).toBeDefined();
    expect(inst!.state).toBe(SessionState.Online);
    expect(inst!.sessionId).toBe('sess-1');
  });

  it('register() adds to getOnlineInstances()', () => {
    router.register('sess-1', '/tmp/test');
    const online = router.getOnlineInstances();
    expect(online).toHaveLength(1);
    expect(online[0].sessionId).toBe('sess-1');
  });

  it('register() twice creates different tokens', () => {
    const a = router.register('sess-1', '/tmp/a');
    const b = router.register('sess-2', '/tmp/b');
    expect(a.token).not.toBe(b.token);
    expect(router.getOnlineInstances()).toHaveLength(2);
  });

  it('unregister() with valid token returns true', () => {
    const { token } = router.register('sess-1', '/tmp/test');
    expect(router.unregister(token)).toBe(true);
    expect(router.getInstance(token)).toBeUndefined();
  });

  it('unregister() with invalid token returns false', () => {
    expect(router.unregister('invalid')).toBe(false);
  });

  it('heartbeat() with valid token returns true and updates lastHeartbeat', () => {
    const { token } = router.register('sess-1', '/tmp/test');
    const before = router.getInstance(token)!.lastHeartbeat;
    vi.advanceTimersByTime(100);
    expect(router.heartbeat(token)).toBe(true);
    expect(router.getInstance(token)!.lastHeartbeat).toBeGreaterThan(before);
  });

  it('heartbeat() with invalid token returns false', () => {
    expect(router.heartbeat('invalid')).toBe(false);
  });

  it('heartbeat() recovers Disconnected instance to Online', () => {
    const { token } = router.register('sess-1', '/tmp/test');
    const inst = router.getInstance(token)!;
    inst.state = SessionState.Disconnected;
    router.heartbeat(token);
    expect(inst.state).toBe(SessionState.Online);
  });

  it('validateSession() returns true for online instance', () => {
    const { token } = router.register('sess-1', '/tmp/test');
    expect(router.validateSession(token)).toBe(true);
  });

  it('validateSession() returns false for invalid token', () => {
    expect(router.validateSession('invalid')).toBe(false);
  });

  it('startCleanup() marks Disconnected after sessionTimeout, removes after 2x', () => {
    const { token } = router.register('sess-1', '/tmp/test');
    router.startCleanup();

    // Advance past sessionTimeout -> should be Disconnected
    vi.advanceTimersByTime(600);
    expect(router.getInstance(token)!.state).toBe(SessionState.Disconnected);

    // Advance past sessionTimeout * 2 total -> should be removed
    vi.advanceTimersByTime(500);
    expect(router.getInstance(token)).toBeUndefined();

    router.stopCleanup();
  });

  it('stopCleanup() stops cleanup logic', () => {
    const { token } = router.register('sess-1', '/tmp/test');
    router.startCleanup();
    router.stopCleanup();
    vi.advanceTimersByTime(2000);
    // Instance should still exist since cleanup stopped
    expect(router.getInstance(token)).toBeDefined();
  });

  it('destroy() clears all instances and stops cleanup', () => {
    router.register('sess-1', '/tmp/test');
    router.startCleanup();
    router.destroy();
    expect(router.getOnlineInstances()).toHaveLength(0);
  });

  describe('register() with terminal info', () => {
    it('stores terminal info when provided', () => {
      const { token } = router.register('sess-1', '/tmp/test', {
        type: 'tmux',
        tmuxSession: '0',
        tmuxPane: '1',
      });
      const inst = router.getInstance(token)!;
      expect(inst.terminal).toEqual({
        type: 'tmux',
        tmuxSession: '0',
        tmuxPane: '1',
      });
    });

    it('stores terminal info with terminal type', () => {
      const { token } = router.register('sess-1', '/tmp/test', { type: 'terminal' });
      const inst = router.getInstance(token)!;
      expect(inst.terminal).toEqual({ type: 'terminal' });
      expect(inst.terminal!.tmuxSession).toBeUndefined();
      expect(inst.terminal!.tmuxPane).toBeUndefined();
    });

    it('stores vscode terminal type', () => {
      const { token } = router.register('sess-1', '/tmp/test', { type: 'vscode' });
      const inst = router.getInstance(token)!;
      expect(inst.terminal!.type).toBe('vscode');
    });

    it('leaves terminal undefined when not provided', () => {
      const { token } = router.register('sess-1', '/tmp/test');
      const inst = router.getInstance(token)!;
      expect(inst.terminal).toBeUndefined();
    });
  });
});
