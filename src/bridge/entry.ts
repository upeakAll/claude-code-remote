import { SessionRouter } from './router.js';
import { ApprovalManager } from './approval.js';
import { BridgeServer } from './server.js';
import { FeishuClient } from './feishu-client.js';
import { MessageQueue } from './message-queue.js';
import { MessageInjector } from './message-injector.js';
import { loadConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

async function main(): Promise<void> {
  const logger = createLogger('bridge-entry');
  const config = loadConfig();
  const router = new SessionRouter(config);
  const approval = new ApprovalManager(router, config);
  const messageQueue = new MessageQueue();
  const feishuClient = new FeishuClient(router, approval, messageQueue, config);
  const server = new BridgeServer(router, approval, feishuClient, messageQueue, config);
  const injector = new MessageInjector(messageQueue, router, feishuClient);

  // Wire up: when user clicks approve/deny on Feishu card, resolve pending approval in server
  feishuClient.setApprovalCallback((requestId, optionValue) => {
    server.resolveApproval(requestId, optionValue);
  });

  await server.start();
  router.startCleanup();
  await feishuClient.start();
  injector.start();

  logger.info({ port: config.server.port }, 'Bridge process fully started');

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down bridge...');
    injector.stop();
    await feishuClient.stop();
    await server.stop();
    messageQueue.destroy();
    approval.destroy();
    router.destroy();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Bridge failed to start:', err);
  process.exit(1);
});
