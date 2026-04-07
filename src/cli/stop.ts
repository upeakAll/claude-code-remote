import * as fs from 'fs';
import { Command } from 'commander';
import { getPidfilePath } from '../utils/platform.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cli:stop');

const SHUTDOWN_TIMEOUT_MS = 5000;

export async function stopAction(): Promise<void> {
  const pidfilePath = getPidfilePath();

  if (!fs.existsSync(pidfilePath)) {
    console.log('Bridge is not running (no pidfile found).');
    return;
  }

  const pidStr = fs.readFileSync(pidfilePath, 'utf-8').trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    console.error('Invalid PID in pidfile. Cleaning up.');
    fs.unlinkSync(pidfilePath);
    return;
  }

  // Check if process is alive
  try {
    process.kill(pid, 0);
  } catch {
    console.log('Bridge process is not running. Cleaning up pidfile.');
    fs.unlinkSync(pidfilePath);
    return;
  }

  // Send SIGTERM
  console.log(`Stopping bridge (PID: ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    console.error('Failed to send SIGTERM.');
    fs.unlinkSync(pidfilePath);
    return;
  }

  // Wait for process to exit
  const startTime = Date.now();
  let exited = false;

  while (Date.now() - startTime < SHUTDOWN_TIMEOUT_MS) {
    try {
      process.kill(pid, 0);
      // Still alive, wait a bit
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch {
      exited = true;
      break;
    }
  }

  if (!exited) {
    // Force kill
    console.log('Bridge did not stop gracefully, sending SIGKILL...');
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process may have just exited
    }
  }

  fs.unlinkSync(pidfilePath);
  logger.info({ pid }, 'Bridge stopped');
  console.log('Bridge stopped.');
}

export function stopCommand(): Command {
  return new Command('stop')
    .description('Stop the bridge daemon')
    .action(stopAction);
}
