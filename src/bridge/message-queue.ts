import { createLogger } from '../utils/logger.js';

const logger = createLogger('message-queue');

export interface QueuedMessage {
  text: string;
  openId: string;
  receivedAt: number;
}

export class MessageQueue {
  private queues: Map<string, QueuedMessage[]> = new Map();
  private readonly logger = logger;

  enqueue(sessionToken: string, message: string, openId: string): void {
    if (!this.queues.has(sessionToken)) {
      this.queues.set(sessionToken, []);
    }
    this.queues.get(sessionToken)!.push({ text: message, openId, receivedAt: Date.now() });
    this.logger.info({ sessionToken: sessionToken.slice(0, 8), openId, textLength: message.length }, 'Message enqueued');
  }

  dequeue(sessionToken: string): QueuedMessage[] {
    const messages = this.queues.get(sessionToken) ?? [];
    this.queues.delete(sessionToken);
    this.logger.debug({ sessionToken: sessionToken.slice(0, 8), count: messages.length }, 'Messages dequeued');
    return messages;
  }

  hasPending(sessionToken: string): boolean {
    return this.queues.has(sessionToken) && this.queues.get(sessionToken)!.length > 0;
  }

  getSessionsWithPending(): string[] {
    const result: string[] = [];
    for (const [token, messages] of this.queues) {
      if (messages.length > 0) {
        result.push(token);
      }
    }
    return result;
  }

  destroy(): void {
    this.queues.clear();
  }
}
