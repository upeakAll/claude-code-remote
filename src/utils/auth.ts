import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getTokenFilePath } from './platform.js';

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function saveToken(workdir: string, token: string): void {
  const tokenPath = getTokenFilePath(workdir);
  const dir = path.dirname(tokenPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tokenPath, token, 'utf-8');
}

export function loadToken(workdir: string): string | null {
  const tokenPath = getTokenFilePath(workdir);
  try {
    return fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

export function removeToken(workdir: string): void {
  const tokenPath = getTokenFilePath(workdir);
  try {
    fs.unlinkSync(tokenPath);
  } catch {
    // 文件不存在时静默忽略
  }
}

export function verifyToken(token: string, expected: string): boolean {
  const tokenBuf = Buffer.from(token, 'utf-8');
  const expectedBuf = Buffer.from(expected, 'utf-8');
  if (tokenBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}
