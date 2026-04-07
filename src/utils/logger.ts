import pino from 'pino';

export function createLogger(module: string) {
  return pino({
    name: `claude-remote:${module}`,
    level: process.env.LOG_LEVEL ?? 'info',
  });
}
