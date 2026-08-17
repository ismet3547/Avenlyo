import { buildApp } from './app.js';
import { env } from './env.js';
import { createMessagingRuntime } from './services/messaging/runtime.js';

const app = buildApp();
const messaging = createMessagingRuntime();
messaging?.start();
app.addHook('onClose', async () => messaging?.stop());

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
