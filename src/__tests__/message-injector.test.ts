import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageInjector } from '../bridge/message-injector.js';
import { MessageQueue } from '../bridge/message-queue.js';
import { SessionRouter, SessionState } from '../bridge/router.js';
import type { FeishuClient } from '../bridge/feishu-client.js';
import type { RemoteConfig } from '../utils/config.js';

const mockExecFile = vi.fn<(cmd: string, args: string[], cb: any) => any>();
vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

vi.mock('../utils/platform.js', () => ({
  getPlatform: vi.fn(() => 'macos'),
}));

const testConfig: RemoteConfig = {
  feishu: { appId: 'test', appSecret: 'test' },
  server: { port: 9876, host: '127.0.0.1' },
  allowedUsers: [],
  heartbeatInterval: 10000,
  sessionTimeout: 60000,
};

function createMockFeishuClient() {
  return {
    sendMessage: vi.fn<Promise<void>, [string, string, string?]>().mockResolvedValue(undefined),
    getBoundUsersBySession: vi.fn().mockReturnValue([]),
  } as unknown as FeishuClient;
}

function setupExecMock() {
  mockExecFile.mockReset();
  mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: any) => {
    cb(null, { stdout: '', stderr: '' });
  });
}

function getCalls(): Array<{ cmd: string; args: string[] }> {
  return mockExecFile.mock.calls.map((c: any) => ({ cmd: c[0], args: c[1] }));
}

describe('MessageInjector', () => {
  let queue: MessageQueue;
  let router: SessionRouter;
  let feishuClient: FeishuClient;
  let injector: MessageInjector;

  beforeEach(() => {
    vi.clearAllMocks();
    queue = new MessageQueue();
    router = new SessionRouter(testConfig);
    feishuClient = createMockFeishuClient();
    injector = new MessageInjector(queue, router, feishuClient);
    setupExecMock();
  });

  afterEach(() => {
    injector.stop();
    queue.destroy();
    router.destroy();
  });

  describe('start/stop', () => {
    it('starts the polling interval', () => {
      injector.start(100);
      expect((injector as any).intervalHandle).not.toBeNull();
      injector.stop();
    });

    it('does not create duplicate interval on double start', () => {
      injector.start(100);
      const first = (injector as any).intervalHandle;
      injector.start(100);
      expect((injector as any).intervalHandle).toBe(first);
      injector.stop();
    });

    it('stops the polling interval', () => {
      injector.start(100);
      injector.stop();
      expect((injector as any).intervalHandle).toBeNull();
    });

    it('stop without start does not throw', () => {
      expect(() => injector.stop()).not.toThrow();
    });
  });

  describe('isSessionIdle', () => {
    it('returns false for non-existent session', () => {
      expect((injector as any).isSessionIdle('nonexistent')).toBe(false);
    });

    it('returns false for offline session', () => {
      const { token } = router.register('sess-1', '/tmp/test', { type: 'tmux', tmuxSession: '0', tmuxPane: '1' });
      const instance = router.getInstance(token)!;
      instance.state = SessionState.Disconnected;
      instance.lastHeartbeat = Date.now() - 6000;
      expect((injector as any).isSessionIdle(token)).toBe(false);
    });

    it('returns false for busy session (recent heartbeat)', () => {
      const { token } = router.register('sess-1', '/tmp/test', { type: 'tmux', tmuxSession: '0', tmuxPane: '1' });
      // lastHeartbeat is now by default
      expect((injector as any).isSessionIdle(token)).toBe(false);
    });

    it('returns true for idle session', () => {
      const { token } = router.register('sess-1', '/tmp/test', { type: 'tmux', tmuxSession: '0', tmuxPane: '1' });
      const instance = router.getInstance(token)!;
      instance.lastHeartbeat = Date.now() - 6000;
      expect((injector as any).isSessionIdle(token)).toBe(true);
    });
  });

  describe('injectToTerminal', () => {
    it('skips when no terminal info', async () => {
      const { token } = router.register('sess-1', '/tmp/test');
      const messages = [{ text: 'hello', openId: 'ou_user', receivedAt: Date.now() }];
      await (injector as any).injectToTerminal(token, messages);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('injects to tmux terminal', async () => {
      const { token } = router.register('sess-1', '/tmp/test', { type: 'tmux', tmuxSession: '0', tmuxPane: '1' });
      const messages = [{ text: 'hello', openId: 'ou_user', receivedAt: Date.now() }];
      await (injector as any).injectToTerminal(token, messages);
      const calls = getCalls();
      expect(calls[0]).toEqual({ cmd: 'tmux', args: ['send-keys', '-t', '0:1', 'hello'] });
      expect(calls[1]).toEqual({ cmd: 'tmux', args: ['send-keys', '-t', '0:1', 'Enter'] });
    });

    it('injects via osascript for vscode terminal on macOS', async () => {
      const { token } = router.register('sess-1', '/tmp/test', { type: 'vscode' });
      const messages = [{ text: 'hello', openId: 'ou_user', receivedAt: Date.now() }];
      await (injector as any).injectToTerminal(token, messages);
      const calls = getCalls();
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[0].cmd).toBe('osascript');
      expect(calls[0].args).toEqual(['-e', 'tell application "System Events" to keystroke "hello"']);
      expect(calls[1].cmd).toBe('osascript');
      expect(calls[1].args).toEqual(['-e', 'tell application "System Events" to keystroke return']);
    });

    it('calls feishuClient.sendMessage after successful injection', async () => {
      const { token } = router.register('sess-1', '/tmp/test', { type: 'tmux', tmuxSession: '0', tmuxPane: '1' });
      const messages = [{ text: 'hello', openId: 'ou_user_123', receivedAt: Date.now() }];
      await (injector as any).injectToTerminal(token, messages);
      expect(feishuClient.sendMessage).toHaveBeenCalledWith('ou_user_123', expect.any(String));
    });
  });

  describe('injectViaTmux', () => {
    it('sends text then Enter', async () => {
      await (injector as any).injectViaTmux('0', '1', 'hello');
      const calls = getCalls();
      expect(calls[0]).toEqual({ cmd: 'tmux', args: ['send-keys', '-t', '0:1', 'hello'] });
      expect(calls[1]).toEqual({ cmd: 'tmux', args: ['send-keys', '-t', '0:1', 'Enter'] });
    });
  });

  describe('injectViaOsascript', () => {
    it('sends keystroke then return via osascript', async () => {
      await (injector as any).injectViaOsascript('hello');
      const calls = getCalls();
      expect(calls[0].cmd).toBe('osascript');
      expect(calls[0].args[0]).toBe('-e');
      expect(calls[0].args[1]).toContain('keystroke "hello"');
      expect(calls[1].cmd).toBe('osascript');
      expect(calls[1].args[1]).toContain('keystroke return');
    });
  });

  describe('escapeForOsascript', () => {
    it('escapes backslashes, quotes, and newlines', () => {
      const result = (injector as any).escapeForOsascript('hello "world"\nline2');
      expect(result).toBe('hello \\"world\\" line2');
    });

    it('escapes backslashes first', () => {
      const result = (injector as any).escapeForOsascript('path\\to\\file');
      expect(result).toBe('path\\\\to\\\\file');
    });

    it('replaces newlines with spaces', () => {
      const result = (injector as any).escapeForOsascript('line1\nline2\nline3');
      expect(result).toBe('line1 line2 line3');
    });
  });

  describe('tick integration', () => {
    it('dequeues and injects for idle sessions', async () => {
      const { token } = router.register('sess-1', '/tmp/test', { type: 'tmux', tmuxSession: '0', tmuxPane: '1' });
      queue.enqueue(token, 'hello', 'ou_user');

      const instance = router.getInstance(token)!;
      instance.lastHeartbeat = Date.now() - 6000;

      (injector as any).tick();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockExecFile).toHaveBeenCalled();
      expect(queue.hasPending(token)).toBe(false);
    });

    it('does nothing when no pending messages', () => {
      router.register('sess-1', '/tmp/test', { type: 'tmux', tmuxSession: '0', tmuxPane: '1' });
      mockExecFile.mockClear();
      (injector as any).tick();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('skips busy session', () => {
      const { token } = router.register('sess-1', '/tmp/test', { type: 'tmux', tmuxSession: '0', tmuxPane: '1' });
      queue.enqueue(token, 'hello', 'ou_user');
      mockExecFile.mockClear();
      (injector as any).tick();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('skips offline session', () => {
      const { token } = router.register('sess-1', '/tmp/test', { type: 'tmux', tmuxSession: '0', tmuxPane: '1' });
      queue.enqueue(token, 'hello', 'ou_user');
      const instance = router.getInstance(token)!;
      instance.state = SessionState.Disconnected;
      instance.lastHeartbeat = Date.now() - 6000;
      mockExecFile.mockClear();
      (injector as any).tick();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('skips nonexistent session', () => {
      queue.enqueue('nonexistent-token', 'hello', 'ou_user');
      mockExecFile.mockClear();
      (injector as any).tick();
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });
});
