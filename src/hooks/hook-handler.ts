import * as crypto from 'crypto';
import { SessionRouter, SessionState } from '../bridge/router.js';
import { ApprovalManager } from '../bridge/approval.js';
import type { ApprovalRequest } from '../bridge/approval.js';
import type { FeishuClient } from '../bridge/feishu-client.js';
import type { MessageQueue } from '../bridge/message-queue.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('hook-handler');

export interface HookPayload {
  type: 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';
  session_id: string;
  request_id?: string;
  content: string;
  tool_name?: string;
  approval_needed?: boolean;
  last_assistant_message?: string;
}

export type HookResult =
  | { status: 'ok' }
  | { status: 'approval_pending'; request_id: string }
  | { status: 'error'; message: string }
  | { decision: 'approve' }
  | { decision: 'block'; reason: string; systemMessage: string };

export class HookHandler {
  private readonly router: SessionRouter;
  private readonly approval: ApprovalManager;
  private readonly feishuClient: FeishuClient;
  private readonly messageQueue: MessageQueue;

  constructor(router: SessionRouter, approval: ApprovalManager, feishuClient: FeishuClient, messageQueue: MessageQueue) {
    this.router = router;
    this.approval = approval;
    this.feishuClient = feishuClient;
    this.messageQueue = messageQueue;
  }

  async handle(payload: HookPayload, sessionToken: string): Promise<HookResult> {
    const instance = this.router.getInstance(sessionToken);
    if (!instance) {
      return { status: 'error', message: 'Session not found' };
    }
    if (instance.state !== SessionState.Online) {
      return { status: 'error', message: 'Session is not online' };
    }

    switch (payload.type) {
      case 'PreToolUse':
        return this.handlePreToolUse(payload, sessionToken);
      case 'PostToolUse':
        return this.handlePostToolUse(payload, sessionToken);
      case 'Notification':
        return this.handleNotification(payload, sessionToken);
      case 'Stop':
        return this.handleStop(payload, sessionToken);
      default:
        return { status: 'error', message: `Unknown hook type: ${payload.type}` };
    }
  }

  private async handlePreToolUse(payload: HookPayload, sessionToken: string): Promise<HookResult> {
    if (payload.approval_needed) {
      const requestId = payload.request_id || crypto.randomUUID();
      const message = this.formatApprovalMessage(payload);

      const approvalRequest = this.approval.enqueue({
        type: 'PreToolUse',
        sessionId: payload.session_id,
        requestId,
        message,
        options: [
          { id: 'allow', label: 'Allow', style: 'primary', value: 'allow' },
          { id: 'deny', label: 'Deny', style: 'danger', value: 'deny' },
        ],
      });

      const openIds = this.feishuClient.getBoundUsersBySession(sessionToken);
      for (const openId of openIds) {
        try {
          await this.feishuClient.sendApprovalCard(openId, approvalRequest);
        } catch (err) {
          logger.error({ err, openId }, 'Failed to send approval card');
        }
      }

      return { status: 'approval_pending', request_id: requestId };
    }

    return { status: 'ok' };
  }

  private async handlePostToolUse(payload: HookPayload, sessionToken: string): Promise<HookResult> {
    const openIds = this.feishuClient.getBoundUsersBySession(sessionToken);
    const toolName = payload.tool_name || 'unknown';

    for (const openId of openIds) {
      try {
        await this.feishuClient.sendToolResult(openId, toolName, payload.content);
      } catch (err) {
        logger.error({ err, openId }, 'Failed to send tool result');
      }
    }

    return { status: 'ok' };
  }

  private async handleNotification(payload: HookPayload, sessionToken: string): Promise<HookResult> {
    const openIds = this.feishuClient.getBoundUsersBySession(sessionToken);

    for (const openId of openIds) {
      try {
        await this.feishuClient.sendRichText(openId, 'Notification', payload.content);
      } catch (err) {
        logger.error({ err, openId }, 'Failed to send notification');
      }
    }

    return { status: 'ok' };
  }

  private async handleStop(payload: HookPayload, sessionToken: string): Promise<HookResult> {
    // Forward CC's response content to bound Feishu users
    const responseText = payload.last_assistant_message || payload.content;
    if (responseText) {
      const openIds = this.feishuClient.getBoundUsersBySession(sessionToken);
      for (const openId of openIds) {
        try {
          await this.feishuClient.sendRichText(openId, 'CC Response', responseText);
        } catch (err) {
          logger.error({ err, openId }, 'Failed to forward Stop response to Feishu');
        }
      }
    }

    if (!this.messageQueue.hasPending(sessionToken)) {
      logger.info('Stop hook: no pending messages, approving');
      return { decision: 'approve' };
    }

    const messages = this.messageQueue.dequeue(sessionToken);
    const formatted = messages
      .map((msg, i) => `[${i + 1}] ${msg.text}`)
      .join('\n');

    logger.info({ sessionToken: sessionToken.slice(0, 8), count: messages.length }, 'Stop hook: blocking with pending messages');

    return {
      decision: 'block',
      reason: `飞书远程消息:\n${formatted}`,
      systemMessage: `飞书远程消息:\n${formatted}`,
    };
  }

  formatApprovalMessage(payload: HookPayload): string {
    const toolName = payload.tool_name || 'unknown';
    const lines: string[] = [
      `**Tool Approval Required**`,
      `Tool: \`${toolName}\``,
      ``,
      payload.content,
    ];
    return lines.join('\n');
  }
}
