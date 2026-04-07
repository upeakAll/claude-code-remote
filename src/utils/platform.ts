import * as os from 'os';
import * as path from 'path';

const CONFIG_DIR_NAME = '.claude-remote';

export function getConfigDir(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

export function getPidfilePath(): string {
  return path.join(getConfigDir(), 'bridge.pid');
}

export function getLogDir(): string {
  return path.join(getConfigDir(), 'logs');
}

export function getTokenFilePath(workdir: string): string {
  return path.join(workdir, '.claude', 'remote-token');
}

export function getPlatform(): 'linux' | 'macos' | 'windows' {
  const platform = os.platform();
  switch (platform) {
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    default: return 'linux';
  }
}

export function isWindows(): boolean {
  return os.platform() === 'win32';
}
