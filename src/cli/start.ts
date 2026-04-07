import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { loadConfig } from '../utils/config.js';
import { getPidfilePath, getLogDir } from '../utils/platform.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cli:start');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getBridgeEntryPath(): string {
  return path.resolve(__dirname, '..', 'bridge', 'entry.js');
}

export async function startAction(): Promise<void> {
  const config = loadConfig();

  if (!config.feishu.appId || !config.feishu.appSecret) {
    console.error('Feishu configuration is missing. Run `claude-remote init` first.');
    process.exit(1);
    return; // unreachable, but ensures type safety for tests
  }

  const pidfilePath = getPidfilePath();

  // Check for existing process
  if (fs.existsSync(pidfilePath)) {
    const existingPid = parseInt(fs.readFileSync(pidfilePath, 'utf-8').trim(), 10);
    if (!isNaN(existingPid)) {
      let isAlive = false;
      try {
        process.kill(existingPid, 0);
        isAlive = true;
      } catch {
        // Process is dead
      }
      if (isAlive) {
        console.error(`Bridge is already running (PID: ${existingPid}).`);
        console.error('Use `claude-remote stop` to stop it first.');
        process.exit(1);
        return; // unreachable, but ensures type safety for tests
      }
      // Clean up stale pidfile
      fs.unlinkSync(pidfilePath);
    } else {
      fs.unlinkSync(pidfilePath);
    }
  }

  const logDir = getLogDir();
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'bridge.log');

  const entryPath = getBridgeEntryPath();

  // Fork the daemon process
  const child = child_process.fork(entryPath, [], {
    detached: true,
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a'), 'ipc'],
  });

  const pid = child.pid;
  if (!pid) {
    console.error('Failed to start bridge daemon.');
    process.exit(1);
  }

  // Write pidfile
  fs.mkdirSync(path.dirname(pidfilePath), { recursive: true });
  fs.writeFileSync(pidfilePath, String(pid), 'utf-8');

  child.unref();

  logger.info({ pid, port: config.server.port }, 'Bridge daemon started');
  console.log(`Bridge started (PID: ${pid})`);
  console.log(`  Server: http://${config.server.host}:${config.server.port}`);
  console.log(`  Log file: ${logFile}`);
}

export function startCommand(): Command {
  return new Command('start')
    .description('Start the bridge daemon')
    .action(startAction);
}
