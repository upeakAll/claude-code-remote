import * as http from 'http';
import * as fs from 'fs';
import { Command } from 'commander';
import { getPidfilePath } from '../utils/platform.js';
import { loadConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cli:status');

const STATUS_TIMEOUT_MS = 3000;

export interface ProcessStatus {
  running: boolean;
  pid: number | null;
}

export interface ServerStatus {
  reachable: boolean;
  data?: {
    server: {
      host: string;
      port: number;
      uptime: number;
    };
    sessions: Array<{
      sessionId: string;
      workdir: string;
      state: string;
      registeredAt: number;
      lastHeartbeat: number;
    }>;
  };
}

export function checkProcessStatus(): ProcessStatus {
  const pidfilePath = getPidfilePath();

  if (!fs.existsSync(pidfilePath)) {
    return { running: false, pid: null };
  }

  const pidStr = fs.readFileSync(pidfilePath, 'utf-8').trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    return { running: false, pid: null };
  }

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid };
  }
}

export function fetchServerStatus(port: number, host: string): Promise<ServerStatus> {
  return new Promise((resolve) => {
    const options: http.RequestOptions = {
      hostname: host,
      port,
      path: '/status',
      method: 'GET',
      timeout: STATUS_TIMEOUT_MS,
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          const data = JSON.parse(body);
          resolve({ reachable: true, data });
        } catch {
          resolve({ reachable: false });
        }
      });
    });

    req.on('error', () => {
      resolve({ reachable: false });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false });
    });

    req.end();
  });
}

export async function statusAction(): Promise<void> {
  const procStatus = checkProcessStatus();

  if (!procStatus.running) {
    if (procStatus.pid !== null) {
      console.log(`Bridge process (PID: ${procStatus.pid}) is not running. Stale pidfile detected.`);
    } else {
      console.log('Bridge is not running.');
    }
    return;
  }

  console.log(`Bridge process is running (PID: ${procStatus.pid})`);

  const config = loadConfig();
  const serverStatus = await fetchServerStatus(config.server.port, config.server.host);

  if (!serverStatus.reachable || !serverStatus.data) {
    console.log('  Server: not reachable (may still be starting up)');
    return;
  }

  const { server, sessions } = serverStatus.data;
  const uptimeSecs = Math.floor(server.uptime);
  const uptimeMins = Math.floor(uptimeSecs / 60);
  const uptimeStr = uptimeMins > 0 ? `${uptimeMins}m ${uptimeSecs % 60}s` : `${uptimeSecs}s`;

  console.log(`  Server: http://${server.host}:${server.port}`);
  console.log(`  Uptime: ${uptimeStr}`);
  console.log(`  Sessions: ${sessions.length}`);

  if (sessions.length > 0) {
    for (const session of sessions) {
      console.log(`    - ${session.sessionId}: ${session.state} (${session.workdir})`);
    }
  }
}

export function statusCommand(): Command {
  return new Command('status')
    .description('Show bridge daemon status')
    .action(statusAction);
}
