// 工具模块统一导出
export { loadConfig, saveConfig, getDefaultConfig } from './utils/config.js';
export type { RemoteConfig } from './utils/config.js';

export { generateToken, saveToken, loadToken, removeToken, verifyToken } from './utils/auth.js';

export {
  getConfigDir,
  getPidfilePath,
  getLogDir,
  getTokenFilePath,
  getPlatform,
  isWindows
} from './utils/platform.js';
