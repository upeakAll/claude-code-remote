import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type { MessageQueue, QueuedMessage } from './message-queue.js';
import type { SessionRouter } from './router.js';
import type { FeishuClient } from './feishu-client.js';
import { createLogger } from '../utils/logger.js';
import { getPlatform } from '../utils/platform.js';

const execFileAsync = promisify(execFile);

const logger = createLogger('message-injector');

export class MessageInjector {
  private readonly queue: MessageQueue;
  private readonly router: SessionRouter;
  private readonly feishuClient: FeishuClient;
  private readonly logger = logger;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly IDLE_THRESHOLD_MS = 5000;
  private readonly INJECT_INTERVAL_MS = 3000;

  constructor(queue: MessageQueue, router: SessionRouter, feishuClient: FeishuClient) {
    this.queue = queue;
    this.router = router;
    this.feishuClient = feishuClient;
  }

  start(intervalMs?: number): void {
    const interval = intervalMs ?? this.INJECT_INTERVAL_MS;
    if (this.intervalHandle) {
      this.logger.warn('MessageInjector already running');
      return;
    }
    this.intervalHandle = setInterval(() => this.tick(), interval);
    this.logger.info({ intervalMs: interval }, 'MessageInjector started');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info('MessageInjector stopped');
    }
  }

  private tick(): void {
    const sessions = this.queue.getSessionsWithPending();
    if (sessions.length === 0) return;

    for (const sessionToken of sessions) {
      if (!this.isSessionIdle(sessionToken)) continue;

      const messages = this.queue.dequeue(sessionToken);
      if (messages.length === 0) continue;

      this.injectToTerminal(sessionToken, messages).catch((err) => {
        this.logger.error({ err, sessionToken: sessionToken.slice(0, 8) }, 'Failed to inject messages');
      });
    }
  }

  private isSessionIdle(sessionToken: string): boolean {
    const instance = this.router.getInstance(sessionToken);
    if (!instance) return false;
    if (instance.state !== 'online') return false;
    const elapsed = Date.now() - instance.lastHeartbeat;
    return elapsed > this.IDLE_THRESHOLD_MS;
  }

  private async injectToTerminal(sessionToken: string, messages: QueuedMessage[]): Promise<void> {
    const instance = this.router.getInstance(sessionToken);
    if (!instance?.terminal) {
      this.logger.warn({ sessionToken: sessionToken.slice(0, 8) }, 'No terminal info, skipping injection');
      return;
    }

    const { terminal } = instance;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      try {
        if (terminal.type === 'tmux' && terminal.tmuxSession && terminal.tmuxPane) {
          await this.injectViaTmux(terminal.tmuxSession, terminal.tmuxPane, msg.text);
        } else if ((terminal.type === 'terminal' || terminal.type === 'vscode') && getPlatform() === 'macos') {
          await this.injectViaOsascript(msg.text);
        } else {
          this.logger.warn(
            { sessionToken: sessionToken.slice(0, 8), terminalType: terminal.type, platform: getPlatform() },
            'Unsupported terminal/platform for injection, skipping'
          );
          continue;
        }

        this.logger.info(
          { sessionToken: sessionToken.slice(0, 8), textLength: msg.text.length, index: i + 1, total: messages.length },
          'Message injected to terminal'
        );

        // Notify Feishu user
        await this.feishuClient.sendMessage(msg.openId, '消息已注入到 CC 会话');

        // Delay between messages (500ms) if more messages remain
        if (i < messages.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (err) {
        this.logger.error(
          { err, sessionToken: sessionToken.slice(0, 8), index: i + 1 },
          'Failed to inject message to terminal'
        );
        // Continue with next message
      }
    }
  }

  private async injectViaTmux(session: string, pane: string, text: string): Promise<void> {
    const target = `${session}:${pane}`;
    await execFileAsync('tmux', ['send-keys', '-t', target, text]);
    await execFileAsync('tmux', ['send-keys', '-t', target, 'Enter']);
    this.logger.debug({ target, textLength: text.length }, 'Injected via tmux');
  }

  private async injectViaOsascript(text: string): Promise<void> {
    // Use clipboard paste approach instead of keystroke, because
    // System Events keystroke sends virtual key codes and cannot handle
    // Chinese/Unicode characters — they get garbled or become "a".
    // pbcopy + Cmd+V preserves the original text including CJK characters.
    // NOTE: This only works when the display is on. For screen-off/locked support,
    // run CC inside tmux — tmux send-keys bypasses the GUI entirely.
    await this.injectViaClipboardPaste(text);
    this.logger.debug({ textLength: text.length }, 'Injected via osascript clipboard paste');
  }

  /**
   * Inject text by copying to clipboard and simulating Cmd+V paste.
   * Works with any Unicode text including Chinese/Japanese/Korean characters.
   * Saves and restores the original clipboard content to avoid clobbering it.
   */
  private async injectViaClipboardPaste(text: string): Promise<void> {
    // Save current clipboard content
    let savedClipboard = '';
    try {
      const { stdout } = await execFileAsync('pbpaste', [], { encoding: 'utf-8' });
      savedClipboard = stdout;
    } catch {
      // Clipboard may be empty or contain non-text data — that's fine
    }

    try {
      // Copy target text to clipboard via pbcopy
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('pbcopy');
        proc.stdin.write(text, 'utf-8');
        proc.stdin.end();
        proc.on('close', (code: number | null) => (code === 0 || code === null) ? resolve() : reject(new Error(`pbcopy exited with ${code}`)));
      });

      // Small delay to ensure clipboard is ready
      await new Promise(resolve => setTimeout(resolve, 50));

      // Simulate Cmd+V paste
      const pasteScript = 'tell application "System Events" to keystroke "v" using command down';
      await execFileAsync('osascript', ['-e', pasteScript]);

      // Wait for paste to complete before pressing Enter
      await new Promise(resolve => setTimeout(resolve, 100));

      // Press Enter to submit
      const enterScript = 'tell application "System Events" to keystroke return';
      await execFileAsync('osascript', ['-e', enterScript]);
    } finally {
      // Restore original clipboard after a delay (paste must complete first)
      setTimeout(() => {
        try {
          const restoreProc = spawn('pbcopy');
          if (savedClipboard) {
            restoreProc.stdin.write(savedClipboard, 'utf-8');
          }
          restoreProc.stdin.end();
        } catch {
          // Best effort
        }
      }, 500);
    }
  }
}
