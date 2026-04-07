import { generateToken, verifyToken } from '../utils/auth.js';
import { loadConfig } from '../utils/config.js';
import type { RemoteConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

export enum SessionState {
  Offline = 'offline',
  Registering = 'registering',
  Online = 'online',
  Disconnected = 'disconnected',
}

export interface TerminalInfo {
  type: 'tmux' | 'terminal' | 'vscode';
  tmuxSession?: string;
  tmuxPane?: string;
}

export interface SessionInstance {
  token: string;
  sessionId: string;
  workdir: string;
  state: SessionState;
  registeredAt: number;
  lastHeartbeat: number;
  terminal?: TerminalInfo;
}

export class SessionRouter {
  private instances: Map<string, SessionInstance> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: RemoteConfig;
  private readonly logger;

  constructor(config?: RemoteConfig) {
    this.config = config ?? loadConfig();
    this.logger = createLogger('router');
  }

  register(sessionId: string, workdir: string, terminal?: TerminalInfo): { token: string } {
    const token = generateToken();
    const now = Date.now();
    const instance: SessionInstance = {
      token,
      sessionId,
      workdir,
      state: SessionState.Online,
      registeredAt: now,
      lastHeartbeat: now,
      terminal,
    };
    this.instances.set(token, instance);
    this.logger.info({ sessionId, workdir, terminalType: terminal?.type }, 'Session registered');
    return { token };
  }

  unregister(token: string): boolean {
    const deleted = this.instances.delete(token);
    if (deleted) {
      this.logger.info({ tokenPrefix: token.slice(0, 8) }, 'Session unregistered');
    }
    return deleted;
  }

  heartbeat(token: string): boolean {
    const instance = this.instances.get(token);
    if (!instance) return false;
    instance.lastHeartbeat = Date.now();
    if (instance.state === SessionState.Disconnected) {
      instance.state = SessionState.Online;
      this.logger.info({ sessionId: instance.sessionId }, 'Session reconnected');
    }
    return true;
  }

  getInstance(token: string): SessionInstance | undefined {
    return this.instances.get(token);
  }

  getOnlineInstances(): SessionInstance[] {
    return Array.from(this.instances.values())
      .filter(inst => inst.state === SessionState.Online);
  }

  validateSession(token: string): boolean {
    const instance = this.instances.get(token);
    return instance !== undefined && instance.state === SessionState.Online;
  }

  startCleanup(): void {
    // No auto-cleanup: sessions are only removed via /unbind from Feishu
    // Heartbeat tracking is kept for status reporting only
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  destroy(): void {
    this.stopCleanup();
    this.instances.clear();
  }
}
