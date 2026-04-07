import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import * as readline from 'readline';
import { Command } from 'commander';
import { loadConfig, saveConfig } from '../utils/config.js';
import { installHooks } from '../hooks/hook-installer.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cli:init');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function installSkill(): void {
  const skillSource = path.resolve(__dirname, '..', 'skill', 'remote.md');
  const skillDir = path.join(os.homedir(), '.claude', 'skills', 'remote');
  const skillTarget = path.join(skillDir, 'remote.md');

  if (!fs.existsSync(skillSource)) {
    logger.warn({ path: skillSource }, 'Skill source not found, skipping skill install');
    return;
  }

  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(skillSource, skillTarget);
  logger.info({ target: skillTarget }, 'Skill installed');
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      resolve(answer.trim());
    });
  });
}

export async function initAction(): Promise<void> {
  const config = loadConfig();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const appId = await prompt(rl, `Feishu App ID [${config.feishu.appId || 'empty'}]: `);
    const appSecret = await prompt(rl, `Feishu App Secret [${config.feishu.appSecret ? '****' : 'empty'}]: `);
    const portStr = await prompt(rl, `Server port [${config.server.port}]: `);
    const allowedUsersStr = await prompt(rl, `Allowed users (comma-separated open_ids) [${config.allowedUsers.join(',') || 'empty'}]: `);

    if (appId) config.feishu.appId = appId;
    if (appSecret) config.feishu.appSecret = appSecret;
    if (portStr) {
      const port = parseInt(portStr, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error('Invalid port number. Must be between 1 and 65535.');
        process.exit(1);
      }
      config.server.port = port;
    }
    if (allowedUsersStr) {
      config.allowedUsers = allowedUsersStr.split(',').map((s) => s.trim()).filter(Boolean);
    }

    saveConfig(config);
    logger.info('Configuration saved');

    installSkill();

    const workdir = process.cwd();
    installHooks(workdir, config.server.port);
    logger.info({ workdir }, 'Hooks installed');

    console.log('Configuration saved and hooks installed successfully.');
    console.log(`  Config file: ~/.claude-remote/config.json`);
    console.log(`  Server port: ${config.server.port}`);
    console.log(`  Feishu App ID: ${config.feishu.appId || '(not set)'}`);
    console.log(`  Allowed users: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(', ') : '(all)'}`);
    console.log(`  Hooks installed in: ${workdir}/.claude/settings.json`);
    console.log(`  Skill installed to: ~/.claude/skills/remote/remote.md`);
  } finally {
    rl.close();
  }
}

export function initCommand(): Command {
  return new Command('init')
    .description('Initialize claude-remote configuration')
    .action(initAction);
}
