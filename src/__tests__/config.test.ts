import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Mock platform.js to use temp directory
vi.mock('../utils/platform.js', () => ({
  getConfigDir: vi.fn()
}));

import { loadConfig, saveConfig, getDefaultConfig } from '../utils/config.js';

const mockedGetConfigDir = vi.mocked(
  await import('../utils/platform.js')
).getConfigDir;

describe('config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-test-'));
    mockedGetConfigDir.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('getDefaultConfig() returns correct defaults', () => {
    const config = getDefaultConfig();
    expect(config.feishu.appId).toBe('');
    expect(config.server.port).toBe(9876);
    expect(config.heartbeatInterval).toBe(30000);
    expect(config.sessionTimeout).toBe(300000);
    expect(config.allowedUsers).toEqual([]);
  });

  it('loadConfig() returns default config when file does not exist', () => {
    const config = loadConfig();
    expect(config).toEqual(getDefaultConfig());
  });

  it('saveConfig() + loadConfig() round-trip', () => {
    const custom = {
      ...getDefaultConfig(),
      feishu: { appId: 'test-app-id', appSecret: 'test-secret' },
      server: { port: 8080, host: '0.0.0.0' },
      allowedUsers: ['user-1'],
    };
    saveConfig(custom);
    const loaded = loadConfig();
    expect(loaded.feishu.appId).toBe('test-app-id');
    expect(loaded.feishu.appSecret).toBe('test-secret');
    expect(loaded.server.port).toBe(8080);
    expect(loaded.allowedUsers).toEqual(['user-1']);
  });

  it('saveConfig() creates directory if not exists', () => {
    const newDir = path.join(tmpDir, 'nested', 'dir');
    mockedGetConfigDir.mockReturnValue(newDir);
    const config = getDefaultConfig();
    saveConfig(config);
    expect(fs.existsSync(path.join(newDir, 'config.json'))).toBe(true);
  });

  it('loadConfig() merges partial config with defaults', () => {
    const partial = { feishu: { appId: 'partial-id', appSecret: '' } };
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(partial), 'utf-8');
    const loaded = loadConfig();
    expect(loaded.feishu.appId).toBe('partial-id');
    expect(loaded.server.port).toBe(9876);
    expect(loaded.heartbeatInterval).toBe(30000);
  });
});
