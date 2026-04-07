import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { SessionRouter, SessionState } from '../bridge/router.js';
import { ApprovalManager } from '../bridge/approval.js';
import { BridgeServer } from '../bridge/server.js';
import { MessageQueue } from '../bridge/message-queue.js';
import type { RemoteConfig } from '../utils/config.js';

const testConfig: RemoteConfig = {
  feishu: { appId: 'test', appSecret: 'test' },
  server: { port: 0, host: '127.0.0.1' },
  allowedUsers: [],
  heartbeatInterval: 10000,
  sessionTimeout: 60000,
};

function httpRequest(options: http.RequestOptions, body?: string): Promise<{ statusCode: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ statusCode: res.statusCode ?? 0, data: JSON.parse(data) });
        } catch {
          resolve({ statusCode: res.statusCode ?? 0, data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function getPort(server: BridgeServer): number {
  return (server as any).actualPort;
}

describe('BridgeServer', () => {
  let router: SessionRouter;
  let approval: ApprovalManager;
  let messageQueue: MessageQueue;
  let server: BridgeServer;
  let port: number;

  beforeEach(async () => {
    router = new SessionRouter(testConfig);
    approval = new ApprovalManager(router, testConfig);
    messageQueue = new MessageQueue();
    server = new BridgeServer(router, approval, null, messageQueue, testConfig);
    await server.start();
    port = getPort(server);
  });

  afterEach(async () => {
    await server.stop();
    messageQueue.destroy();
    approval.destroy();
    router.destroy();
  });

  it('returns 404 for unknown path', async () => {
    const res = await httpRequest({ hostname: '127.0.0.1', port, path: '/unknown', method: 'GET' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /register returns token', async () => {
    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ session_id: 'test-session', workdir: '/tmp/test' })
    );
    expect(res.statusCode).toBe(200);
    expect(res.data.token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(res.data.token)).toBe(true);
  });

  it('POST /register without session_id returns 400', async () => {
    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ workdir: '/tmp/test' })
    );
    expect(res.statusCode).toBe(400);
    expect(res.data.error).toBe('session_id required');
  });

  it('POST /register without workdir returns 400', async () => {
    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ session_id: 'test-session' })
    );
    expect(res.statusCode).toBe(400);
    expect(res.data.error).toBe('workdir required');
  });

  it('POST /register with invalid JSON returns 400', async () => {
    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      'not json'
    );
    expect(res.statusCode).toBe(400);
    expect(res.data.error).toBe('Invalid JSON body');
  });

  describe('POST /register with terminal info', () => {
    it('registers with tmux terminal info', async () => {
      const res = await httpRequest(
        { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ session_id: 's1', workdir: '/tmp', terminal: { type: 'tmux', tmuxSession: '0', tmuxPane: '0' } })
      );
      expect(res.statusCode).toBe(200);
      const inst = server.getRouter().getInstance(res.data.token);
      expect(inst!.terminal).toEqual({ type: 'tmux', tmuxSession: '0', tmuxPane: '0' });
    });

    it('registers with terminal type', async () => {
      const res = await httpRequest(
        { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ session_id: 's1', workdir: '/tmp', terminal: { type: 'terminal' } })
      );
      expect(res.statusCode).toBe(200);
      const inst = server.getRouter().getInstance(res.data.token);
      expect(inst!.terminal!.type).toBe('terminal');
      expect(inst!.terminal!.tmuxSession).toBeUndefined();
      expect(inst!.terminal!.tmuxPane).toBeUndefined();
    });

    it('registers without terminal info (backward compatible)', async () => {
      const res = await httpRequest(
        { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ session_id: 's1', workdir: '/tmp' })
      );
      expect(res.statusCode).toBe(200);
      const inst = server.getRouter().getInstance(res.data.token);
      expect(inst!.terminal).toBeUndefined();
    });

    it('ignores invalid terminal type', async () => {
      const res = await httpRequest(
        { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ session_id: 's1', workdir: '/tmp', terminal: { type: 'unknown' } })
      );
      expect(res.statusCode).toBe(200);
      const inst = server.getRouter().getInstance(res.data.token);
      expect(inst!.terminal).toBeUndefined();
    });

    it('registers with vscode terminal type', async () => {
      const res = await httpRequest(
        { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ session_id: 's1', workdir: '/tmp', terminal: { type: 'vscode' } })
      );
      expect(res.statusCode).toBe(200);
      const inst = server.getRouter().getInstance(res.data.token);
      expect(inst!.terminal!.type).toBe('vscode');
    });
  });

  it('POST /hook with Notification returns ok', async () => {
    const reg = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ session_id: 'test-session', workdir: '/tmp/test' })
    );
    const token = reg.data.token;

    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token } },
      JSON.stringify({ type: 'Notification', session_id: 'test-session', content: 'hello' })
    );
    expect(res.statusCode).toBe(200);
    expect(res.data.status).toBe('ok');
  });

  it('POST /hook without token returns 401', async () => {
    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ type: 'Notification', session_id: 'test-session', content: 'hello' })
    );
    expect(res.statusCode).toBe(401);
    expect(res.data.error).toBe('Token required');
  });

  it('POST /hook with invalid token returns 401', async () => {
    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': 'invalid-token' } },
      JSON.stringify({ type: 'Notification', session_id: 'test-session', content: 'hello' })
    );
    expect(res.statusCode).toBe(401);
    expect(res.data.error).toBe('Invalid token');
  });

  it('POST /hook with PreToolUse + approval_needed returns approval_pending', async () => {
    const reg = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ session_id: 'test-session', workdir: '/tmp/test' })
    );
    const token = reg.data.token;

    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token } },
      JSON.stringify({ type: 'PreToolUse', session_id: 'test-session', content: 'Allow Bash?', approval_needed: true })
    );
    expect(res.statusCode).toBe(200);
    expect(res.data.status).toBe('approval_pending');
    expect(res.data.request_id).toBeDefined();
    // Verify approval request exists
    const pending = approval.getPendingRequests('test-session');
    expect(pending).toHaveLength(1);
  });

  it('POST /hook with invalid type returns 400', async () => {
    const reg = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ session_id: 'test-session', workdir: '/tmp/test' })
    );
    const token = reg.data.token;

    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token } },
      JSON.stringify({ type: 'InvalidType', session_id: 'test-session', content: 'test' })
    );
    expect(res.statusCode).toBe(400);
    expect(res.data.error).toBe('Invalid hook type');
  });

  it('POST /unregister with valid token returns ok', async () => {
    const reg = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ session_id: 'test-session', workdir: '/tmp/test' })
    );
    const token = reg.data.token;

    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/unregister', method: 'POST', headers: { 'X-Token': token } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.data.status).toBe('ok');

    // Verify session removed from /status
    const statusRes = await httpRequest({ hostname: '127.0.0.1', port, path: '/status', method: 'GET' });
    expect(statusRes.data.sessions).toHaveLength(0);
  });

  it('POST /unregister with invalid token returns 404', async () => {
    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/unregister', method: 'POST', headers: { 'X-Token': 'invalid-token' } }
    );
    expect(res.statusCode).toBe(404);
    expect(res.data.error).toBe('Session not found');
  });

  it('POST /unregister without token returns 401', async () => {
    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/unregister', method: 'POST' }
    );
    expect(res.statusCode).toBe(401);
    expect(res.data.error).toBe('Token required');
  });

  it('GET /status returns server info and sessions', async () => {
    await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ session_id: 'test-session', workdir: '/tmp/test' })
    );

    const res = await httpRequest({ hostname: '127.0.0.1', port, path: '/status', method: 'GET' });
    expect(res.statusCode).toBe(200);
    expect(res.data.server).toBeDefined();
    expect(res.data.server.host).toBe('127.0.0.1');
    expect(res.data.server.uptime).toBeTypeOf('number');
    expect(res.data.sessions).toHaveLength(1);
    expect(res.data.sessions[0].sessionId).toBe('test-session');
    expect(res.data.sessions[0].workdir).toBe('/tmp/test');
    expect(res.data.sessions[0].state).toBe('online');
  });

  it('stop() closes server and rejects new connections', async () => {
    await server.stop();
    await expect(
      httpRequest({ hostname: '127.0.0.1', port, path: '/status', method: 'GET', timeout: 1000 })
    ).rejects.toThrow();
    // Prevent afterEach from calling stop again
    (server as any).server = null;
  });

  it('POST /hook with Stop returns decision approve when no pending messages', async () => {
    const reg = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ session_id: 'test-session', workdir: '/tmp/test' })
    );
    const token = reg.data.token;

    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token } },
      JSON.stringify({ type: 'Stop', session_id: 'test-session', content: '' })
    );
    expect(res.statusCode).toBe(200);
    expect(res.data.decision).toBe('approve');
  });

  it('POST /hook with Stop returns block when pending messages exist', async () => {
    const reg = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ session_id: 'test-session', workdir: '/tmp/test' })
    );
    const token = reg.data.token;

    // Enqueue a message for this session
    messageQueue.enqueue(token, 'hello from feishu', 'ou_user');

    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token } },
      JSON.stringify({ type: 'Stop', session_id: 'test-session', content: '' })
    );
    expect(res.statusCode).toBe(200);
    expect(res.data.decision).toBe('block');
    expect(res.data.reason).toContain('[1]');
    expect(res.data.systemMessage).toContain('飞书远程消息');
  });

  it('POST /hook with Stop clears queue after block, subsequent stop approves', async () => {
    const reg = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ session_id: 'test-session', workdir: '/tmp/test' })
    );
    const token = reg.data.token;

    messageQueue.enqueue(token, 'msg1', 'ou_user');

    const first = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token } },
      JSON.stringify({ type: 'Stop', session_id: 'test-session', content: '' })
    );
    expect(first.data.decision).toBe('block');

    const second = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token } },
      JSON.stringify({ type: 'Stop', session_id: 'test-session', content: '' })
    );
    expect(second.data.decision).toBe('approve');
  });

  it('POST /hook with Stop merges multiple messages', async () => {
    const reg = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ session_id: 'test-session', workdir: '/tmp/test' })
    );
    const token = reg.data.token;

    messageQueue.enqueue(token, 'msg1', 'ou_user');
    messageQueue.enqueue(token, 'msg2', 'ou_user');

    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token } },
      JSON.stringify({ type: 'Stop', session_id: 'test-session', content: '' })
    );
    expect(res.data.decision).toBe('block');
    expect(res.data.reason).toContain('[1]');
    expect(res.data.reason).toContain('[2]');
  });

  it('POST /hook with Stop without token returns 401', async () => {
    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ type: 'Stop', session_id: 'test-session', content: '' })
    );
    expect(res.statusCode).toBe(401);
  });

  it('POST /hook with Stop and invalid token returns 401', async () => {
    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': 'invalid-token' } },
      JSON.stringify({ type: 'Stop', session_id: 'test-session', content: '' })
    );
    expect(res.statusCode).toBe(401);
  });

  it('POST /hook with PostToolUse returns ok without approval', async () => {
    const reg = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ session_id: 'test-session', workdir: '/tmp/test' })
    );
    const token = reg.data.token;

    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token } },
      JSON.stringify({ type: 'PostToolUse', session_id: 'test-session', content: 'result' })
    );
    expect(res.statusCode).toBe(200);
    expect(res.data.status).toBe('ok');
    // No approval request created
    const pending = approval.getPendingRequests('test-session');
    expect(pending).toHaveLength(0);
  });
});
