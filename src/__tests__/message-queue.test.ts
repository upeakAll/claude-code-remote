import { describe, it, expect, beforeEach } from 'vitest';
import { MessageQueue } from '../bridge/message-queue.js';

describe('MessageQueue', () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue();
  });

  it('enqueue single message', () => {
    queue.enqueue('tok-1', 'hello', 'ou_user');
    expect(queue.hasPending('tok-1')).toBe(true);
    expect(queue.getSessionsWithPending()).toContain('tok-1');
  });

  it('enqueue multiple messages to same session', () => {
    queue.enqueue('tok-1', 'msg1', 'ou_user');
    queue.enqueue('tok-1', 'msg2', 'ou_user');
    queue.enqueue('tok-1', 'msg3', 'ou_user');
    const messages = queue.dequeue('tok-1');
    expect(messages).toHaveLength(3);
    expect(messages[0].receivedAt).toBeLessThanOrEqual(messages[1].receivedAt);
    expect(messages[1].receivedAt).toBeLessThanOrEqual(messages[2].receivedAt);
  });

  it('dequeue returns and clears messages', () => {
    queue.enqueue('tok-1', 'msg1', 'ou_user');
    queue.enqueue('tok-1', 'msg2', 'ou_user');
    const first = queue.dequeue('tok-1');
    expect(first).toHaveLength(2);
    const second = queue.dequeue('tok-1');
    expect(second).toHaveLength(0);
  });

  it('dequeue non-existent session returns empty', () => {
    const result = queue.dequeue('nonexist');
    expect(result).toEqual([]);
  });

  it('hasPending returns false when no messages', () => {
    expect(queue.hasPending('tok-1')).toBe(false);
    queue.enqueue('tok-1', 'msg', 'ou_user');
    queue.dequeue('tok-1');
    expect(queue.hasPending('tok-1')).toBe(false);
  });

  it('getSessionsWithPending returns multiple sessions', () => {
    queue.enqueue('tok-1', 'msg', 'ou_user');
    queue.enqueue('tok-2', 'msg', 'ou_user');
    const sessions = queue.getSessionsWithPending();
    expect(sessions).toContain('tok-1');
    expect(sessions).toContain('tok-2');
  });

  it('getSessionsWithPending partial consumption', () => {
    queue.enqueue('tok-1', 'msg', 'ou_user');
    queue.enqueue('tok-2', 'msg', 'ou_user');
    queue.dequeue('tok-1');
    const sessions = queue.getSessionsWithPending();
    expect(sessions).toEqual(['tok-2']);
  });

  it('QueuedMessage fields are correct', () => {
    queue.enqueue('tok-1', 'hello world', 'ou_user');
    const [msg] = queue.dequeue('tok-1');
    expect(msg.text).toBe('hello world');
    expect(msg.openId).toBe('ou_user');
    expect(typeof msg.receivedAt).toBe('number');
    expect(msg.receivedAt).toBeGreaterThan(0);
  });

  it('destroy clears all queues', () => {
    queue.enqueue('tok-1', 'msg1', 'ou_user');
    queue.enqueue('tok-2', 'msg2', 'ou_user');
    queue.destroy();
    expect(queue.getSessionsWithPending()).toEqual([]);
    expect(queue.hasPending('tok-1')).toBe(false);
    expect(queue.hasPending('tok-2')).toBe(false);
  });
});
