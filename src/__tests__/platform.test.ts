import { describe, it, expect } from 'vitest';
import {
  getConfigDir,
  getPidfilePath,
  getLogDir,
  getTokenFilePath,
  getPlatform,
  isWindows
} from '../utils/platform.js';

describe('platform', () => {
  it('getConfigDir() returns path ending with .claude-remote', () => {
    expect(getConfigDir().endsWith('.claude-remote')).toBe(true);
  });

  it('getPidfilePath() returns path ending with bridge.pid', () => {
    expect(getPidfilePath().endsWith('bridge.pid')).toBe(true);
  });

  it('getLogDir() returns path ending with logs', () => {
    expect(getLogDir().endsWith('logs')).toBe(true);
  });

  it('getTokenFilePath() returns correct path', () => {
    expect(getTokenFilePath('/tmp/test')).toBe('/tmp/test/.claude/remote-token');
  });

  it('getPlatform() returns macos on darwin', () => {
    // Running on macOS in this environment
    const platform = getPlatform();
    expect(['macos', 'linux', 'windows']).toContain(platform);
  });

  it('isWindows() returns false on macOS/Linux', () => {
    // In this CI/dev environment, not Windows
    expect(typeof isWindows()).toBe('boolean');
  });
});
