import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SKILL_PATH = path.resolve(__dirname, '../skill/remote.md');

describe('src/skill/remote.md', () => {
  let content: string;

  it('file exists in src/skill/', () => {
    expect(fs.existsSync(SKILL_PATH)).toBe(true);
  });

  // Read once for all subsequent assertions
  content = fs.readFileSync(SKILL_PATH, 'utf-8');

  it('has valid frontmatter with name and description', () => {
    expect(content).toContain('name: remote');
    expect(content).toContain('description:');
    expect(content).toContain('user-invocable: true');
  });

  it('contains all three flow section names', () => {
    expect(content).toContain('连接注册');
    expect(content).toContain('断开连接');
    expect(content).toContain('查看状态');
  });

  it('references claude-remote CLI commands', () => {
    expect(content).toContain('claude-remote register');
    expect(content).toContain('claude-remote remote-status');
  });

  it('mentions tmux requirement and terminal detection', () => {
    expect(content).toContain('tmux');
  });

  it('references settings.json and hooks', () => {
    expect(content).toContain('settings.json');
    expect(content).toContain('hooks');
  });

  it('references remote-token file', () => {
    expect(content).toContain('remote-token');
  });

  it('references bridge server status check', () => {
    expect(content).toContain('Bridge');
    expect(content).toContain('claude-remote start');
  });

  it('has complete markdown structure with ordered steps under each section', () => {
    const onSection = content.match(/连接注册[\s\S]*?(?=---|\z)/)?.[0] ?? '';
    const statusSection = content.match(/查看状态[\s\S]*$/)?.[0] ?? '';

    // On section should have numbered steps
    expect(onSection).toMatch(/1\./);
    expect(onSection).toMatch(/2\./);
    expect(onSection).toMatch(/3\./);
    expect(onSection).toMatch(/4\./);
    expect(onSection).toMatch(/5\./);

    // Status section should have numbered steps
    expect(statusSection).toMatch(/1\./);
    expect(statusSection).toMatch(/2\./);
    expect(statusSection).toMatch(/3\./);
  });
});
