import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Mock platform.js
vi.mock('../utils/platform.js', () => ({
  getTokenFilePath: vi.fn()
}));

import {
  generateToken,
  saveToken,
  loadToken,
  removeToken,
  verifyToken
} from '../utils/auth.js';

const mockedGetTokenFilePath = vi.mocked(
  await import('../utils/platform.js')
).getTokenFilePath;

describe('auth', () => {
  let tmpDir: string;
  let tokenPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-auth-'));
    tokenPath = path.join(tmpDir, '.claude', 'remote-token');
    mockedGetTokenFilePath.mockReturnValue(tokenPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('generateToken() returns 64-char hex string', () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });

  it('generateToken() returns different values on each call', () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1).not.toBe(t2);
  });

  it('saveToken() + loadToken() round-trip', () => {
    const token = generateToken();
    saveToken(tmpDir, token);
    const loaded = loadToken(tmpDir);
    expect(loaded).toBe(token);
  });

  it('loadToken() returns null when file does not exist', () => {
    expect(loadToken(tmpDir)).toBeNull();
  });

  it('removeToken() deletes token file', () => {
    saveToken(tmpDir, 'test-token');
    expect(loadToken(tmpDir)).toBe('test-token');
    removeToken(tmpDir);
    expect(loadToken(tmpDir)).toBeNull();
  });

  it('removeToken() does not throw when file does not exist', () => {
    expect(() => removeToken(tmpDir)).not.toThrow();
  });

  it('verifyToken() returns true for matching tokens', () => {
    const token = generateToken();
    expect(verifyToken(token, token)).toBe(true);
  });

  it('verifyToken() returns false for different tokens', () => {
    expect(verifyToken('token-a', 'token-b')).toBe(false);
  });

  it('verifyToken() returns false for different length tokens without throwing', () => {
    expect(verifyToken('short', 'a-much-longer-token-value')).toBe(false);
  });
});
