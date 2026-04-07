import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('hook-installer');

interface HookEntry {
  matcher: string;
  command: string;
}

interface HooksConfig {
  hooks: {
    PreToolUse: HookEntry[];
    PostToolUse: HookEntry[];
    Notification: HookEntry[];
    Stop: HookEntry[];
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getTemplatePath(): string {
  return path.resolve(__dirname, '../../templates/settings-hooks.json');
}

export function loadTemplate(port?: number): HooksConfig {
  const templatePath = getTemplatePath();
  const raw = fs.readFileSync(templatePath, 'utf-8');
  const config: HooksConfig = JSON.parse(raw);

  if (port !== undefined && port !== 9876) {
    const serialized = JSON.stringify(config);
    const replaced = serialized.replace(/127\.0\.0\.1:9876/g, `127.0.0.1:${port}`);
    return JSON.parse(replaced);
  }

  return config;
}

export function installHooks(workdir: string, port?: number): void {
  const settingsDir = path.join(workdir, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');

  let settings: Record<string, any> = {};

  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw);
  }

  const hooksConfig = loadTemplate(port);

  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const [hookType, entries] of Object.entries(hooksConfig.hooks)) {
    if (!settings.hooks[hookType]) {
      settings.hooks[hookType] = [];
    }

    for (const entry of entries) {
      const alreadyExists = (settings.hooks[hookType] as HookEntry[]).some(
        (existing: HookEntry) => existing.command === entry.command
      );
      if (!alreadyExists) {
        settings.hooks[hookType].push(entry);
      }
    }
  }

  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  logger.info({ workdir, port }, 'Hooks installed');
}

export function uninstallHooks(workdir: string): void {
  const settingsPath = path.join(workdir, '.claude', 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    return;
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const settings: Record<string, any> = JSON.parse(raw);

  if (!settings.hooks) {
    return;
  }

  for (const hookType of Object.keys(settings.hooks)) {
    const entries = settings.hooks[hookType] as HookEntry[];
    settings.hooks[hookType] = entries.filter(
      (entry: HookEntry) => !entry.command.includes('127.0.0.1')
    );

    if ((settings.hooks[hookType] as HookEntry[]).length === 0) {
      delete settings.hooks[hookType];
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  logger.info({ workdir }, 'Hooks uninstalled');
}

export function isHooksInstalled(workdir: string, port?: number): boolean {
  const settingsPath = path.join(workdir, '.claude', 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    return false;
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const settings: Record<string, any> = JSON.parse(raw);

  if (!settings.hooks) {
    return false;
  }

  const hooksConfig = loadTemplate(port);
  const targetPort = port ?? 9876;
  const hookUrl = `127.0.0.1:${targetPort}`;

  for (const hookType of Object.keys(hooksConfig.hooks)) {
    const entries = settings.hooks[hookType] as HookEntry[] | undefined;
    if (!entries || !Array.isArray(entries)) {
      return false;
    }
    const hasMatchingEntry = entries.some(
      (entry: HookEntry) => entry.command.includes(hookUrl)
    );
    if (!hasMatchingEntry) {
      return false;
    }
  }

  return true;
}
