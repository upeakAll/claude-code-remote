import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile, execSync } from 'child_process';
import { Command } from 'commander';
import { loadConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cli');

function httpPost(url: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error(`Invalid JSON: ${buf}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
  });
}

function httpGet(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let buf = '';
      res.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error(`Invalid JSON: ${buf}`)); }
      });
    });
  });
}

function generateSessionId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function mergeHooks(settingsPath: string, token: string, port: number): void {
  // Read template
  const templatePath = path.join(__dirname, '..', '..', 'templates', 'settings-hooks.json');
  let template: any;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
  } catch {
    logger.error('Hook template not found');
    return;
  }

  // Replace token and port
  const hooksStr = JSON.stringify(template)
    .replace(/\$REMOTE_TOKEN/g, token)
    .replace(/127\.0.0.1:9876/g, `127.0.0.1:${port}`);
  const hooks = JSON.parse(hooksStr);

  // Read existing settings
  let settings: any = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    settings = {};
  }

  if (!settings.hooks) settings.hooks = {};

  // Merge each hook type
  for (const hookType of Object.keys(hooks.hooks)) {
    if (!settings.hooks[hookType]) settings.hooks[hookType] = [];
    const newEntries = hooks.hooks[hookType];
    for (const entry of newEntries) {
      const exists = settings.hooks[hookType].some((e: any) =>
        JSON.stringify(e) === JSON.stringify(entry)
      );
      if (!exists) {
        settings.hooks[hookType].push(entry);
      }
    }
  }

  // Write back
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  logger.info({ path: settingsPath }, 'Hooks merged into settings.json');
}

async function doRegister(workdir: string): Promise<void> {
  const config = loadConfig();
  const port = config.server.port || 9876;
  const host = config.server.host || '127.0.0.1';
  const baseUrl = `http://${host}:${port}`;

  // 1. Check bridge is running
  try {
    const status = await httpGet(`${baseUrl}/status`);
    logger.info({ port: status.server.port, sessions: status.sessions?.length }, 'Bridge is running');
  } catch {
    console.error('ERROR: Bridge server is not running. Start it first with: claude-remote start');
    process.exit(1);
  }

  // 2. Check tmux
  const tmuxEnv = process.env.TMUX;
  if (!tmuxEnv) {
    console.error('');
    console.error('⚠️  远程控制需要 CC 在 tmux 中运行（支持熄屏/锁屏状态下接收飞书消息）。');
    console.error('请先安装 tmux（brew install tmux），然后：');
    console.error('  1. tmux new -s claude');
    console.error('  2. 在 tmux 会话内重新启动 claude');
    console.error('  3. 再次运行 /remote');
    console.error('');
    process.exit(1);
  }

  // 3. Parse tmux info
  const tmuxPaneId = tmuxEnv.split(',')[1];
  let tmuxSession = '';
  let tmuxPane = '';
  try {
    tmuxSession = execSync(`tmux list-panes -t "${tmuxPaneId}" -F '#{session_name}' 2>/dev/null`).toString().trim();
    tmuxPane = execSync(`tmux list-panes -t "${tmuxPaneId}" -F '#{pane_index}' 2>/dev/null`).toString().trim();
  } catch {
    logger.warn('Failed to get tmux session info, using defaults');
    tmuxSession = '0';
    tmuxPane = '0';
  }

  // 4. Generate session ID
  const sessionId = generateSessionId();

  // 5. Register with bridge
  const registerBody = {
    session_id: sessionId,
    workdir,
    terminal: {
      type: 'tmux',
      tmuxSession,
      tmuxPane,
    },
  };

  const regResult = await httpPost(`${baseUrl}/register`, registerBody);
  if (!regResult.token) {
    console.error('Registration failed:', JSON.stringify(regResult));
    process.exit(1);
  }

  const token = regResult.token;

  // 6. Save token file
  const claudeDir = path.join(workdir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const tokenPath = path.join(claudeDir, 'remote-token');
  fs.writeFileSync(tokenPath, token, 'utf-8');
  logger.info({ path: tokenPath }, 'Token saved');

  // 7. Merge hooks into settings.json
  const settingsPath = path.join(claudeDir, 'settings.json');
  const actualPort = (await httpGet(`${baseUrl}/status`)).server?.port || port;
  mergeHooks(settingsPath, token, actualPort);

  // 8. Report success
  console.log('');
  console.log('Remote session registered.');
  console.log(`  Session ID: ${sessionId}`);
  console.log(`  Token: ${token.slice(0, 8)}...`);
  console.log(`  Hooks installed in .claude/settings.json`);
  console.log(`  Tmux: ${tmuxSession}:${tmuxPane}`);
  console.log('');
}

async function doStatus(workdir: string): Promise<void> {
  const config = loadConfig();
  const port = config.server.port || 9876;
  const host = config.server.host || '127.0.0.1';
  const baseUrl = `http://${host}:${port}`;
  const claudeDir = path.join(workdir, '.claude');
  const tokenPath = path.join(claudeDir, 'remote-token');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // Check token file
  let tokenPresent = false;
  let token = '';
  try {
    token = fs.readFileSync(tokenPath, 'utf-8').trim();
    tokenPresent = true;
  } catch {
    tokenPresent = false;
  }

  if (!tokenPresent) {
    console.log('No remote session registered for this project.');
    return;
  }

  // Check bridge
  let bridgeOnline = false;
  let bridgeStatus: any = null;
  try {
    bridgeStatus = await httpGet(`${baseUrl}/status`);
    bridgeOnline = true;
  } catch {
    bridgeOnline = false;
  }

  // Check hooks
  let hooksInstalled = false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (settings.hooks) {
      const types = Object.keys(settings.hooks);
      hooksInstalled = types.some(t =>
        (settings.hooks[t] as any[])?.some((e: any) =>
          JSON.stringify(e).includes('127.0.0.1')
        )
      ) || false;
    }
  } catch {
    hooksInstalled = false;
  }

  console.log('');
  console.log('Remote session status:');
  console.log(`  Token file: ${tokenPresent ? 'present' : 'missing'}`);
  console.log(`  Bridge server: ${bridgeOnline ? 'online' : 'offline'}`);
  if (bridgeOnline && bridgeStatus) {
    console.log(`  Server port: ${bridgeStatus.server?.port || port}`);
    console.log(`  Active sessions: ${bridgeStatus.sessions?.length ?? 0}`);
  }
  console.log(`  Hooks installed: ${hooksInstalled ? 'yes' : 'no'}`);
  console.log('');
}

export async function doRegisterAction(): Promise<void> {
  const workdir = process.cwd();
  await doRegister(workdir);
}

export async function doStatusAction(): Promise<void> {
  const workdir = process.cwd();
  await doStatus(workdir);
}
