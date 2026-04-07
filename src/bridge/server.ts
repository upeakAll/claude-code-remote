import * as http from 'http';
import * as crypto from 'crypto';
import { loadConfig } from '../utils/config.js';
import type { RemoteConfig } from '../utils/config.js';
import { verifyToken } from '../utils/auth.js';
import { createLogger } from '../utils/logger.js';
import { SessionRouter, type TerminalInfo } from './router.js';
import { ApprovalManager } from './approval.js';
import type { FeishuClient } from './feishu-client.js';
import { MessageQueue } from './message-queue.js';

interface HookPayload {
  // CC standard fields
  type?: 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';
  hook_event_name?: 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';
  session_id: string;
  request_id?: string;
  content?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  message?: string;
  notification_type?: string;
  approval_needed?: boolean;
  last_assistant_message?: string;
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  stop_hook_active?: boolean;
}

function sendJSON(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, statusCode: number, message: string): void {
  sendJSON(res, statusCode, { error: message });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export class BridgeServer {
  private server: http.Server | null = null;
  private readonly router: SessionRouter;
  private readonly approval: ApprovalManager;
  private readonly feishuClient: FeishuClient | null;
  private readonly messageQueue: MessageQueue;
  private readonly pendingApprovals: Map<string, { resolve: (value: string) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
  private readonly config: RemoteConfig;
  private readonly logger;
  private actualPort: number;
  readonly port: number;

  constructor(router: SessionRouter, approval: ApprovalManager, feishuClient: FeishuClient | null, messageQueue: MessageQueue, config?: RemoteConfig) {
    this.router = router;
    this.approval = approval;
    this.feishuClient = feishuClient ?? null;
    this.messageQueue = messageQueue;
    this.config = config ?? loadConfig();
    this.actualPort = this.config.server.port;
    this.port = this.config.server.port;
    this.logger = createLogger('server');
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.actualPort, this.config.server.host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.actualPort = addr.port;
        }
        this.logger.info({ host: this.config.server.host, port: this.actualPort }, 'Bridge server started');
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) { resolve(); return; }
      this.router.stopCleanup();
      const srv = this.server;
      this.server = null;
      srv.close((err) => {
        if (err) reject(err);
        else {
          this.logger.info('Bridge server stopped');
          resolve();
        }
      });
    });
  }

  getRouter(): SessionRouter { return this.router; }
  getApproval(): ApprovalManager { return this.approval; }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const { method } = req;
    const pathname = req.url?.split('?')[0] ?? '';

    if (method === 'POST' && pathname === '/hook') {
      this.handleHook(req, res);
    } else if (method === 'POST' && pathname === '/register') {
      this.handleRegister(req, res);
    } else if (method === 'POST' && pathname === '/unregister') {
      this.handleUnregister(req, res);
    } else if (method === 'GET' && pathname === '/status') {
      this.handleStatus(req, res);
    } else if (method === 'POST' && pathname === '/card') {
      this.handleCardAction(req, res);
    } else {
      sendError(res, 404, 'Not Found');
    }
  }

  private async handleHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const headerToken = req.headers['x-token'] as string | undefined;
    if (!headerToken) {
      sendError(res, 401, 'Token required');
      return;
    }

    // Find matching instance by iterating online instances
    const onlineInstances = this.router.getOnlineInstances();
    let matchedToken: string | null = null;
    for (const inst of onlineInstances) {
      if (verifyToken(headerToken, inst.token)) {
        matchedToken = inst.token;
        break;
      }
    }

    if (!matchedToken) {
      sendError(res, 401, 'Invalid token');
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 400, 'Failed to read request body');
      return;
    }

    let payload: HookPayload;
    try {
      payload = JSON.parse(body) as HookPayload;
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }

    // Normalize hook type from CC's actual payload format
    const hookType = (payload.hook_event_name || payload.type || '') as string;
    const validTypes = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
    if (!validTypes.includes(hookType)) {
      sendError(res, 400, `Invalid hook type: ${hookType}`);
      return;
    }

    // Extract content from CC's varying payload formats
    // CC uses different fields depending on hook type:
    //   Notification: message
    //   PreToolUse: tool_name + tool_input
    //   PostToolUse: tool_name + tool_input + tool_response
    //   Stop: last_assistant_message
    const hookContent = payload.content
      || payload.message
      || payload.last_assistant_message
      || (payload.tool_input ? JSON.stringify(payload.tool_input) : '')
      || '';

    this.logger.info({
      hookType,
      hasContent: !!payload.content,
      hasLastAssistant: !!payload.last_assistant_message,
      hasToolInput: !!payload.tool_input,
      hasToolResponse: !!payload.tool_response,
      hookContentLength: hookContent.length,
      payloadKeys: Object.keys(payload),
    }, 'Hook payload analysis');

    // Update heartbeat
    this.router.heartbeat(matchedToken);

    // Handle PreToolUse — send approval card to Feishu and wait for user action
    if (hookType === 'PreToolUse') {
      const instance = this.router.getInstance(matchedToken)!;
      const toolName = payload.tool_name ?? 'unknown';
      const toolInput = (typeof payload.tool_input === 'string'
        ? (() => { try { return JSON.parse(payload.tool_input!); } catch { return {}; } })()
        : payload.tool_input) as Record<string, unknown> ?? {};

      // Format approval content by tool type for readability
      const requestMessage = this.formatToolApprovalContent(toolName, toolInput);

      const requestId = payload.request_id ?? payload.tool_use_id ?? crypto.randomUUID();
      const request = this.approval.enqueue({
        type: 'PreToolUse',
        sessionId: instance.sessionId,
        requestId,
        message: requestMessage,
        options: [
          { id: 'allow', label: '✅ 允许', style: 'primary', value: 'allow' },
          { id: 'deny', label: '❌ 拒绝', style: 'danger', value: 'deny' },
        ],
      });

      // Send approval card to bound Feishu users
      if (this.feishuClient) {
        const openIds = this.feishuClient.getBoundUsersBySession(matchedToken);
        for (const openId of openIds) {
          try {
            await this.feishuClient.sendApprovalCard(openId, request);
          } catch (err) {
            this.logger.error({ err, openId }, 'Failed to send approval card');
          }
        }
      }

      // Wait for Feishu user to respond (with timeout)
      const APPROVAL_TIMEOUT_MS = 300_000; // 5 minutes, only Feishu can approve/deny
      const decision = await this.waitForApproval(requestId, APPROVAL_TIMEOUT_MS);

      this.logger.info({ requestId, decision }, 'PreToolUse approval resolved');
      if (decision === 'allow') {
        sendJSON(res, 200, { decision: 'approve' });
      } else {
        // 'deny' or 'timeout' — both block, only Feishu can allow
        sendJSON(res, 200, { decision: 'block', reason: decision === 'deny' ? '用户通过飞书拒绝了此工具调用' : '审批超时，已自动拒绝' });
      }
      return;
    }

    // Handle Stop hook — forward CC response to Feishu, then check message queue
    if (hookType === 'Stop') {
      // Forward CC's response content to bound Feishu users
      const responseText = payload.last_assistant_message || hookContent;
      this.logger.info({
        hasFeishuClient: !!this.feishuClient,
        responseTextLength: responseText?.length ?? 0,
        matchedToken: matchedToken.slice(0, 8),
      }, 'Stop hook: checking Feishu forwarding');
      if (this.feishuClient && responseText) {
        const openIds = this.feishuClient.getBoundUsersBySession(matchedToken);
        this.logger.info({ openIds, count: openIds.length }, 'Stop hook: bound users for forwarding');
        for (const openId of openIds) {
          try {
            await this.feishuClient.sendRichText(openId, 'CC Response', responseText);
          } catch (err) {
            this.logger.error({ err, openId }, 'Failed to forward Stop response to Feishu');
          }
        }
      }

      if (!this.messageQueue.hasPending(matchedToken)) {
        this.logger.info('Stop hook: no pending messages, approving');
        sendJSON(res, 200, { decision: 'approve' });
        return;
      }

      const messages = this.messageQueue.dequeue(matchedToken);
      const formatted = messages
        .map((msg, i) => `[${i + 1}] ${msg.text}`)
        .join('\n');

      this.logger.info({ count: messages.length }, 'Stop hook: blocking with pending messages');
      sendJSON(res, 200, {
        decision: 'block',
        reason: `飞书远程消息:\n${formatted}`,
        systemMessage: `飞书远程消息:\n${formatted}`,
      });
      return;
    }

    // Forward Notification/PostToolUse/PreToolUse events to bound Feishu users
    if (this.feishuClient) {
      const openIds = this.feishuClient.getBoundUsersBySession(matchedToken);
      for (const openId of openIds) {
        try {
          if (hookType === 'Notification') {
            const notifMessage = payload.message || hookContent || '(无内容)';
            const notifType = payload.notification_type || '';
            const title = notifType ? `Notification: ${notifType}` : 'Notification';
            await this.feishuClient.sendRichText(openId, title, notifMessage);
          } else if (hookType === 'PreToolUse') {
            // Show tool call info
            const toolName = payload.tool_name ?? 'unknown';
            const toolDesc = payload.tool_input
              ? (typeof payload.tool_input === 'string' ? payload.tool_input : JSON.stringify(payload.tool_input).slice(0, 500))
              : '';
            await this.feishuClient.sendRichText(openId, `Tool: ${toolName}`, `**Calling:** \`${toolName}\`\n${toolDesc}`);
          } else if (hookType === 'PostToolUse') {
            const toolName = payload.tool_name ?? 'unknown';
            // Prefer tool_response over tool_input for results
            const responseText = payload.tool_response
              ? (typeof payload.tool_response === 'string' ? payload.tool_response : JSON.stringify(payload.tool_response).slice(0, 3000))
              : hookContent;
            await this.feishuClient.sendToolResult(openId, toolName, responseText);
          }
        } catch (err) {
          this.logger.error({ err, openId }, 'Failed to forward event to Feishu');
        }
      }
    }

    this.logger.info({ type: hookType }, 'Hook event received');
    sendJSON(res, 200, { status: 'ok' });
  }

  /**
   * Wait for an approval response from Feishu card callback.
   * Returns 'allow', 'deny', or 'timeout'.
   */
  private waitForApproval(requestId: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(requestId);
        resolve('timeout');
      }, timeoutMs);

      this.pendingApprovals.set(requestId, { resolve, timer });
    });
  }

  /** Resolve a pending approval (called from card callback handler) */
  resolveApproval(requestId: string, optionValue: string): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(requestId);
    pending.resolve(optionValue);
    return true;
  }

  /** Truncate content for display */
  private truncateContent(content: string, maxLen: number): string {
    if (!content) return '';
    if (content.length <= maxLen) return content;
    return content.slice(0, maxLen) + '...[truncated]';
  }

  /**
   * Format tool approval content for Feishu card display.
   * Generates a human-readable summary based on tool type.
   */
  private formatToolApprovalContent(toolName: string, toolInput: Record<string, unknown>): string {
    const MAX_DETAIL = 3000;

    switch (toolName) {
      case 'Bash': {
        const command = String(toolInput.command ?? '');
        const description = String(toolInput.description ?? '');
        let msg = `**🔧 Bash 命令**\n`;
        if (description) msg += `\n> ${description}\n`;
        msg += `\n\`\`\`bash\n${this.truncateContent(command, MAX_DETAIL)}\n\`\`\``;
        return msg;
      }
      case 'Write': {
        const filePath = String(toolInput.file_path ?? '');
        const content = String(toolInput.content ?? '');
        let msg = `**📝 写入文件**\n`;
        msg += `\n📁 \`${filePath}\`\n`;
        msg += `\n<details><summary>文件内容（${content.length} 字符）</summary>\n\n`;
        msg += `\`\`\`\n${this.truncateContent(content, MAX_DETAIL)}\n\`\`\`\n</details>`;
        return msg;
      }
      case 'Edit': {
        const filePath = String(toolInput.file_path ?? '');
        const oldStr = String(toolInput.old_string ?? '');
        const newStr = String(toolInput.new_string ?? '');
        let msg = `**✏️ 编辑文件**\n`;
        msg += `\n📁 \`${filePath}\`\n`;
        msg += `\n**替换前:**\n\`\`\`\n${this.truncateContent(oldStr, 1000)}\n\`\`\``;
        msg += `\n**替换后:**\n\`\`\`\n${this.truncateContent(newStr, 1000)}\n\`\`\``;
        return msg;
      }
      case 'Read': {
        const filePath = String(toolInput.file_path ?? '');
        const offset = toolInput.offset ?? '';
        const limit = toolInput.limit ?? '';
        let msg = `**📖 读取文件**\n`;
        msg += `\n📁 \`${filePath}\``;
        if (offset || limit) msg += ` (offset: ${offset}, limit: ${limit})`;
        return msg;
      }
      case 'WebFetch':
      case 'WebSearch': {
        const url = String(toolInput.url ?? toolInput.query ?? '');
        return `**🌐 ${toolName}**\n\n\`${this.truncateContent(url, 500)}\``;
      }
      case 'NotebookEdit': {
        const nbPath = String(toolInput.notebook_path ?? '');
        return `**📓 编辑 Notebook**\n\n📁 \`${nbPath}\``;
      }
      default: {
        // Generic fallback: show all input fields
        const detail = JSON.stringify(toolInput, null, 2);
        return `**🔧 ${toolName}**\n\n\`\`\`json\n${this.truncateContent(detail, MAX_DETAIL)}\n\`\`\``;
      }
    }
  }

  private async handleRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 400, 'Failed to read request body');
      return;
    }

    let data: { session_id?: string; workdir?: string; terminal?: { type?: string; tmuxSession?: string; tmuxPane?: string } };
    try {
      data = JSON.parse(body) as typeof data;
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }

    if (!data.session_id || typeof data.session_id !== 'string') {
      sendError(res, 400, 'session_id required');
      return;
    }

    if (!data.workdir || typeof data.workdir !== 'string') {
      sendError(res, 400, 'workdir required');
      return;
    }

    // Parse optional terminal info
    let terminal: TerminalInfo | undefined;
    if (data.terminal && data.terminal.type) {
      const validTypes = ['tmux', 'terminal', 'vscode'];
      if (validTypes.includes(data.terminal.type)) {
        terminal = {
          type: data.terminal.type as 'tmux' | 'terminal' | 'vscode',
          tmuxSession: data.terminal.tmuxSession,
          tmuxPane: data.terminal.tmuxPane,
        };
      }
    }

    const result = this.router.register(data.session_id, data.workdir, terminal);
    sendJSON(res, 200, { token: result.token });
  }

  private async handleUnregister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = req.headers['x-token'] as string | undefined;
    if (!token) {
      sendError(res, 401, 'Token required');
      return;
    }

    const instance = this.router.getInstance(token);
    const deleted = this.router.unregister(token);
    if (!deleted) {
      sendError(res, 404, 'Session not found');
      return;
    }

    // Clean up approval requests for this session
    if (instance) {
      this.approval.removeSessionRequests(instance.sessionId);
    }

    sendJSON(res, 200, { status: 'ok' });
  }

  private handleStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
    const instances = this.router.getOnlineInstances();
    sendJSON(res, 200, {
      server: {
        host: this.config.server.host,
        port: this.actualPort,
        uptime: process.uptime(),
      },
      sessions: instances.map(inst => ({
        sessionId: inst.sessionId,
        workdir: inst.workdir,
        state: inst.state,
        registeredAt: inst.registeredAt,
        lastHeartbeat: inst.lastHeartbeat,
      })),
    });
  }

  private async handleCardAction(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 400, 'Failed to read request body');
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(body) as Record<string, unknown>;
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }

    // Handle Feishu card action callback
    const openId = data.open_id as string | undefined;
    const action = data.action as { tag?: string; value?: Record<string, string> } | undefined;

    if (!openId || !action?.value) {
      sendJSON(res, 200, { status: 'ok' });
      return;
    }

    const { requestId, optionId, action: actionType, token, chatId } = action.value;

    // Approval response — resolve pending approval promise
    if (requestId) {
      const response = this.approval.respond(requestId, optionId ?? '');
      if (response) {
        this.logger.info({ requestId, optionId, value: response.value }, 'Approval responded via card callback');
        // Also resolve the pending waitForApproval promise if present
        this.resolveApproval(requestId, response.value);
      }
    }

    // Instance binding
    if (actionType === 'bind' && token && chatId && this.feishuClient) {
      const instance = this.router.getInstance(token);
      if (instance && instance.state === 'online') {
        this.feishuClient.bindUserSession(openId, chatId, token);
        this.logger.info({ openId, sessionId: instance.sessionId }, 'User bound via card callback');
      }
    }

    sendJSON(res, 200, { status: 'ok' });
  }
}
