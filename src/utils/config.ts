import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './platform.js';

export interface RemoteConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
  server: {
    port: number;
    host: string;
  };
  allowedUsers: string[];
  heartbeatInterval: number;
  sessionTimeout: number;
}

export function getDefaultConfig(): RemoteConfig {
  return {
    feishu: { appId: '', appSecret: '' },
    server: { port: 9876, host: '127.0.0.1' },
    allowedUsers: [],
    heartbeatInterval: 30000,
    sessionTimeout: 300000
  };
}

export function loadConfig(): RemoteConfig {
  const configPath = path.join(getConfigDir(), 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...getDefaultConfig(), ...parsed };
  } catch {
    return getDefaultConfig();
  }
}

export function saveConfig(config: RemoteConfig): void {
  const configDir = getConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
