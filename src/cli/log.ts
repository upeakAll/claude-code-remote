import * as fs from 'fs';
import * as readline from 'readline';
import { Command } from 'commander';
import { getLogDir } from '../utils/platform.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cli:log');

const DEFAULT_LINES = 50;

export async function logAction(options: { n?: string; follow?: boolean }): Promise<void> {
  const logDir = getLogDir();
  const logFile = `${logDir}/bridge.log`;

  if (!fs.existsSync(logFile)) {
    console.log('No log file found. Is the bridge running?');
    return;
  }

  const lineCount = options.n ? parseInt(options.n, 10) : DEFAULT_LINES;
  if (isNaN(lineCount) || lineCount < 1) {
    console.error('Invalid line count. Must be a positive integer.');
    process.exit(1);
  }

  if (options.follow) {
    // Tail -f mode: read from end of file, then watch for changes
    const stat = fs.statSync(logFile);
    const stream = fs.createReadStream(logFile, {
      start: stat.size,
      encoding: 'utf-8',
    });

    stream.on('data', (chunk: string | Buffer) => {
      process.stdout.write(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    });

    const watcher = fs.watch(logFile, (eventType) => {
      if (eventType === 'change') {
        const newStat = fs.statSync(logFile);
        const readStream = fs.createReadStream(logFile, {
          start: stat.size,
          end: newStat.size,
          encoding: 'utf-8',
        });
        readStream.on('data', (chunk: string | Buffer) => {
          process.stdout.write(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
        });
        // Update stat for next watch
        Object.assign(stat, newStat);
      }
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      watcher.close();
      stream.destroy();
      process.exit(0);
    });

    return;
  }

  // Read last N lines
  const content = fs.readFileSync(logFile, 'utf-8');
  const lines = content.split('\n');

  // Remove trailing empty line if present
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const start = Math.max(0, lines.length - lineCount);
  const tailLines = lines.slice(start);

  console.log(tailLines.join('\n'));
}

export function logCommand(): Command {
  return new Command('log')
    .description('View bridge daemon logs')
    .option('-n, --lines <count>', 'Number of lines to show', String(DEFAULT_LINES))
    .option('-f, --follow', 'Follow log output')
    .action(logAction);
}
