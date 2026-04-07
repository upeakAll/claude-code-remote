import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

// --- Mocks ---

vi.mock('../utils/config.js', () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  getDefaultConfig: vi.fn(),
}));

vi.mock('../utils/platform.js', () => ({
  getConfigDir: vi.fn(() => path.join(os.tmpdir(), 'claude-remote-test')),
  getPidfilePath: vi.fn(),
  getLogDir: vi.fn(),
  getTokenFilePath: vi.fn(),
  getPlatform: vi.fn(() => 'macos'),
  isWindows: vi.fn(() => false),
}));

vi.mock('../hooks/hook-installer.js', () => ({
  installHooks: vi.fn(),
  uninstallHooks: vi.fn(),
}));

vi.mock('child_process', () => ({
  fork: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Import mocked modules
const { loadConfig } = await import('../utils/config.js');
const { getPidfilePath, getLogDir } = await import('../utils/platform.js');
const { installHooks } = await import('../hooks/hook-installer.js');
const cp = await import('child_process');

const mockedLoadConfig = vi.mocked(loadConfig);
const mockedGetPidfilePath = vi.mocked(getPidfilePath);
const mockedGetLogDir = vi.mocked(getLogDir);
const mockedInstallHooks = vi.mocked(installHooks);
const mockedFork = vi.mocked(cp.fork);

// --- Helpers ---

const defaultConfig = {
  feishu: { appId: 'test-app-id', appSecret: 'test-app-secret' },
  server: { port: 9876, host: '127.0.0.1' },
  allowedUsers: [] as string[],
  heartbeatInterval: 30000,
  sessionTimeout: 300000,
};

function makeConfig(overrides: Record<string, any> = {}) {
  return { ...defaultConfig, ...overrides };
}

// --- Tests ---

describe('CLI Commands', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-cli-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ========== init.ts ==========

  describe('initCommand', () => {
    it('returns a command with name "init"', async () => {
      const { initCommand } = await import('../cli/init.js');
      const cmd = initCommand();
      expect(cmd.name()).toBe('init');
    });

    it('has a description', async () => {
      const { initCommand } = await import('../cli/init.js');
      const cmd = initCommand();
      expect(cmd.description()).toBeTruthy();
    });
  });

  // ========== start.ts ==========

  describe('startCommand', () => {
    it('returns a command with name "start"', async () => {
      const { startCommand } = await import('../cli/start.js');
      const cmd = startCommand();
      expect(cmd.name()).toBe('start');
    });
  });

  describe('getBridgeEntryPath', () => {
    it('returns a path ending with bridge/entry.js', async () => {
      const { getBridgeEntryPath } = await import('../cli/start.js');
      const entryPath = getBridgeEntryPath();
      expect(entryPath).toMatch(/bridge[\/\\]entry\.js$/);
    });
  });

  describe('startAction', () => {
    it('exits with error when feishu config is missing', async () => {
      mockedLoadConfig.mockReturnValue(makeConfig({
        feishu: { appId: '', appSecret: '' },
      }));
      mockedGetPidfilePath.mockReturnValue(path.join(tmpDir, 'bridge.pid'));
      mockedGetLogDir.mockReturnValue(path.join(tmpDir, 'logs'));

      const { startAction } = await import('../cli/start.js');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(startAction()).rejects.toThrow('process.exit(1)');

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('exits with error when bridge is already running', async () => {
      const pidfilePath = path.join(tmpDir, 'bridge.pid');
      // Write a PID that is alive (our own process)
      fs.writeFileSync(pidfilePath, String(process.pid), 'utf-8');

      mockedLoadConfig.mockReturnValue(makeConfig());
      mockedGetPidfilePath.mockReturnValue(pidfilePath);
      mockedGetLogDir.mockReturnValue(path.join(tmpDir, 'logs'));

      const { startAction } = await import('../cli/start.js');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(startAction()).rejects.toThrow('process.exit(1)');

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('cleans up stale pidfile and starts daemon', async () => {
      const pidfilePath = path.join(tmpDir, 'bridge.pid');
      const logDir = path.join(tmpDir, 'logs');
      // Write a PID that is definitely dead (PID 999999999)
      fs.writeFileSync(pidfilePath, '999999999', 'utf-8');

      mockedLoadConfig.mockReturnValue(makeConfig());
      mockedGetPidfilePath.mockReturnValue(pidfilePath);
      mockedGetLogDir.mockReturnValue(logDir);

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
      };
      mockedFork.mockReturnValue(mockChild as any);

      const { startAction } = await import('../cli/start.js');

      await startAction();

      // Should have forked
      expect(mockedFork).toHaveBeenCalled();
      expect(mockChild.unref).toHaveBeenCalled();
      // Pidfile should now contain new PID
      expect(fs.readFileSync(pidfilePath, 'utf-8')).toBe('12345');
    });
  });

  // ========== stop.ts ==========

  describe('stopCommand', () => {
    it('returns a command with name "stop"', async () => {
      const { stopCommand } = await import('../cli/stop.js');
      const cmd = stopCommand();
      expect(cmd.name()).toBe('stop');
    });
  });

  describe('stopAction', () => {
    it('reports bridge not running when no pidfile', async () => {
      mockedGetPidfilePath.mockReturnValue(path.join(tmpDir, 'nonexistent.pid'));

      const { stopAction } = await import('../cli/stop.js');

      // Should not throw, just log
      await expect(stopAction()).resolves.toBeUndefined();
    });

    it('cleans up pidfile when process is dead', async () => {
      const pidfilePath = path.join(tmpDir, 'bridge.pid');
      fs.writeFileSync(pidfilePath, '999999999', 'utf-8');

      mockedGetPidfilePath.mockReturnValue(pidfilePath);

      const { stopAction } = await import('../cli/stop.js');

      await stopAction();

      expect(fs.existsSync(pidfilePath)).toBe(false);
    });

    it('sends SIGTERM to running process', async () => {
      const pidfilePath = path.join(tmpDir, 'bridge.pid');
      // Use our own PID (which is alive)
      fs.writeFileSync(pidfilePath, String(process.pid), 'utf-8');

      mockedGetPidfilePath.mockReturnValue(pidfilePath);

      const killSpy = vi.spyOn(process, 'kill');

      // Make the process appear dead after SIGTERM
      let killCallCount = 0;
      killSpy.mockImplementation((_pid: number, signal?: string | number) => {
        killCallCount++;
        // After SIGTERM is sent (call 2), subsequent alive-checks (signal 0) should fail
        if (signal === 0 && killCallCount > 2) {
          throw new Error('ESRCH');
        }
        return true;
      });

      const { stopAction } = await import('../cli/stop.js');

      await stopAction();

      expect(killSpy).toHaveBeenCalled();
      killSpy.mockRestore();
    });

    it('handles invalid PID in pidfile', async () => {
      const pidfilePath = path.join(tmpDir, 'bridge.pid');
      fs.writeFileSync(pidfilePath, 'not-a-number', 'utf-8');

      mockedGetPidfilePath.mockReturnValue(pidfilePath);

      const { stopAction } = await import('../cli/stop.js');

      await stopAction();

      // Should clean up invalid pidfile
      expect(fs.existsSync(pidfilePath)).toBe(false);
    });
  });

  // ========== status.ts ==========

  describe('statusCommand', () => {
    it('returns a command with name "status"', async () => {
      const { statusCommand } = await import('../cli/status.js');
      const cmd = statusCommand();
      expect(cmd.name()).toBe('status');
    });
  });

  describe('checkProcessStatus', () => {
    it('returns not running when no pidfile', async () => {
      mockedGetPidfilePath.mockReturnValue(path.join(tmpDir, 'nonexistent.pid'));

      const { checkProcessStatus } = await import('../cli/status.js');

      const result = checkProcessStatus();
      expect(result.running).toBe(false);
      expect(result.pid).toBeNull();
    });

    it('returns running with pid when process is alive', async () => {
      const pidfilePath = path.join(tmpDir, 'bridge.pid');
      fs.writeFileSync(pidfilePath, String(process.pid), 'utf-8');

      mockedGetPidfilePath.mockReturnValue(pidfilePath);

      const { checkProcessStatus } = await import('../cli/status.js');

      const result = checkProcessStatus();
      expect(result.running).toBe(true);
      expect(result.pid).toBe(process.pid);
    });

    it('returns not running when process is dead', async () => {
      const pidfilePath = path.join(tmpDir, 'bridge.pid');
      fs.writeFileSync(pidfilePath, '999999999', 'utf-8');

      mockedGetPidfilePath.mockReturnValue(pidfilePath);

      const { checkProcessStatus } = await import('../cli/status.js');

      const result = checkProcessStatus();
      expect(result.running).toBe(false);
      expect(result.pid).toBe(999999999);
    });

    it('handles invalid PID in pidfile', async () => {
      const pidfilePath = path.join(tmpDir, 'bridge.pid');
      fs.writeFileSync(pidfilePath, 'invalid', 'utf-8');

      mockedGetPidfilePath.mockReturnValue(pidfilePath);

      const { checkProcessStatus } = await import('../cli/status.js');

      const result = checkProcessStatus();
      expect(result.running).toBe(false);
      expect(result.pid).toBeNull();
    });
  });

  describe('fetchServerStatus', () => {
    it('returns reachable with data on success', async () => {
      // Create a test server
      const server = http.createServer((req, res) => {
        if (req.url === '/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            server: { host: '127.0.0.1', port: 0, uptime: 123.45 },
            sessions: [{ sessionId: 'test-session', workdir: '/tmp', state: 'online', registeredAt: 1, lastHeartbeat: 2 }],
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const serverPort = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            resolve(addr.port);
          }
        });
      });

      const { fetchServerStatus } = await import('../cli/status.js');

      const result = await fetchServerStatus(serverPort, '127.0.0.1');
      expect(result.reachable).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.server.host).toBe('127.0.0.1');
      expect(result.data!.sessions).toHaveLength(1);

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('returns unreachable on connection refused', async () => {
      const { fetchServerStatus } = await import('../cli/status.js');

      const result = await fetchServerStatus(59999, '127.0.0.1');
      expect(result.reachable).toBe(false);
    });

    it('returns unreachable on timeout', async () => {
      // Create a server that never responds
      const slowServer = http.createServer(() => {
        // Never respond
      });
      const slowPort = await new Promise<number>((resolve) => {
        slowServer.listen(0, '127.0.0.1', () => {
          const addr = slowServer.address();
          if (addr && typeof addr === 'object') {
            resolve(addr.port);
          }
        });
      });

      const { fetchServerStatus } = await import('../cli/status.js');

      const result = await fetchServerStatus(slowPort, '127.0.0.1');
      expect(result.reachable).toBe(false);

      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    }, 10000);
  });

  describe('statusAction', () => {
    it('reports not running when no pidfile', async () => {
      mockedGetPidfilePath.mockReturnValue(path.join(tmpDir, 'nonexistent.pid'));

      const { statusAction } = await import('../cli/status.js');

      // Should not throw
      await expect(statusAction()).resolves.toBeUndefined();
    });

    it('reports process running but server unreachable', async () => {
      const pidfilePath = path.join(tmpDir, 'bridge.pid');
      fs.writeFileSync(pidfilePath, String(process.pid), 'utf-8');

      mockedGetPidfilePath.mockReturnValue(pidfilePath);
      mockedLoadConfig.mockReturnValue(makeConfig({
        server: { port: 59999, host: '127.0.0.1' },
      }));

      const { statusAction } = await import('../cli/status.js');

      // Should not throw
      await expect(statusAction()).resolves.toBeUndefined();
    });
  });

  // ========== log.ts ==========

  describe('logCommand', () => {
    it('returns a command with name "log"', async () => {
      const { logCommand } = await import('../cli/log.js');
      const cmd = logCommand();
      expect(cmd.name()).toBe('log');
    });
  });

  describe('logAction', () => {
    it('reports no log file when not found', async () => {
      mockedGetLogDir.mockReturnValue(path.join(tmpDir, 'no-logs'));

      const { logAction } = await import('../cli/log.js');

      await expect(logAction({})).resolves.toBeUndefined();
    });

    it('reads last N lines from log file', async () => {
      const logDir = path.join(tmpDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'bridge.log');

      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
      fs.writeFileSync(logFile, lines.join('\n'), 'utf-8');

      mockedGetLogDir.mockReturnValue(logDir);

      const { logAction } = await import('../cli/log.js');

      // Capture console.log
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await logAction({ n: '5' });

      // Should output last 5 lines
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('Line 6');
      expect(output).toContain('Line 10');
      expect(output).not.toContain('Line 5');

      logSpy.mockRestore();
    });

    it('handles empty log file', async () => {
      const logDir = path.join(tmpDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'bridge.log');
      fs.writeFileSync(logFile, '', 'utf-8');

      mockedGetLogDir.mockReturnValue(logDir);

      const { logAction } = await import('../cli/log.js');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await logAction({ n: '10' });

      // Empty file should produce empty output
      expect(logSpy).toHaveBeenCalledWith('');
      logSpy.mockRestore();
    });

    it('handles --n with default when not specified', async () => {
      const logDir = path.join(tmpDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'bridge.log');

      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
      fs.writeFileSync(logFile, lines.join('\n'), 'utf-8');

      mockedGetLogDir.mockReturnValue(logDir);

      const { logAction } = await import('../cli/log.js');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await logAction({});

      const output = logSpy.mock.calls[0][0];
      // Default is 50 lines, so should contain Line 51 through Line 100
      expect(output).toContain('Line 51');
      expect(output).toContain('Line 100');
      expect(output).not.toContain('Line 50');

      logSpy.mockRestore();
    });
  });
});
