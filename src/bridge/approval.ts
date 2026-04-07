import * as crypto from 'crypto';
import { loadConfig } from '../utils/config.js';
import type { RemoteConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import type { SessionRouter } from './router.js';

export interface ApprovalOption {
  id: string;
  label: string;
  style: 'primary' | 'danger' | 'default';
  value: string;
}

export interface ApprovalRequest {
  type: 'PreToolUse' | 'custom';
  sessionId: string;
  requestId: string;
  message: string;
  options: ApprovalOption[];
  createdAt: number;
  timeoutMs: number;
}

export interface ApprovalResponse {
  requestId: string;
  optionId: string;
  value: string;
  respondedAt: number;
}

export type ApprovalResult = 'approved' | 'denied' | 'timeout';

export class ApprovalManager {
  private requests: Map<string, ApprovalRequest> = new Map();
  private responses: Map<string, ApprovalResponse> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly router: SessionRouter;
  private readonly config: RemoteConfig;
  private readonly logger;

  constructor(router: SessionRouter, config?: RemoteConfig) {
    this.router = router;
    this.config = config ?? loadConfig();
    this.logger = createLogger('approval');
  }

  enqueue(request: Omit<ApprovalRequest, 'createdAt' | 'timeoutMs'>): ApprovalRequest {
    const fullRequest: ApprovalRequest = {
      ...request,
      requestId: request.requestId || crypto.randomUUID(),
      createdAt: Date.now(),
      timeoutMs: this.config.sessionTimeout,
    };
    this.requests.set(fullRequest.requestId, fullRequest);
    this.startRequestTimer(fullRequest.requestId);
    this.logger.info(
      { requestId: fullRequest.requestId, sessionId: request.sessionId, optionCount: request.options.length },
      'Approval request enqueued'
    );
    return fullRequest;
  }

  respond(requestId: string, optionId: string): ApprovalResponse | null {
    const request = this.requests.get(requestId);
    if (!request) return null;
    const option = request.options.find(opt => opt.id === optionId);
    if (!option) return null;
    const response: ApprovalResponse = {
      requestId,
      optionId,
      value: option.value,
      respondedAt: Date.now(),
    };
    this.responses.set(requestId, response);
    this.requests.delete(requestId);
    this.clearRequestTimer(requestId);
    this.logger.info({ requestId, optionId }, 'Approval responded');
    return response;
  }

  getResponse(requestId: string): ApprovalResponse | null {
    return this.responses.get(requestId) ?? null;
  }

  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.requests.get(requestId);
  }

  getPendingRequests(sessionId: string): ApprovalRequest[] {
    return Array.from(this.requests.values())
      .filter(req => req.sessionId === sessionId);
  }

  removeSessionRequests(sessionId: string): void {
    for (const [requestId, req] of this.requests) {
      if (req.sessionId === sessionId) {
        this.clearRequestTimer(requestId);
        this.requests.delete(requestId);
      }
    }
  }

  private startRequestTimer(requestId: string): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    const timer = setTimeout(() => {
      const req = this.requests.get(requestId);
      if (req) {
        this.requests.delete(requestId);
        this.logger.info({ requestId }, 'Approval request timed out');
      }
      this.timers.delete(requestId);
    }, request.timeoutMs);
    this.timers.set(requestId, timer);
  }

  private clearRequestTimer(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(requestId);
    }
  }

  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.requests.clear();
    this.responses.clear();
  }
}
