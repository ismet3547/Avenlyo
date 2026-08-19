import { env } from './env.js';
import { createMessagingRuntime } from './services/messaging/runtime.js';
import { createBillingRuntime } from './services/billing/runtime.js';
import { buildApp } from './app.js';

const messaging = createMessagingRuntime();
const billing = createBillingRuntime();
const app = buildApp({ billingService: billing?.service ?? null });
messaging?.start();
billing?.start();
app.addHook('onClose', async () => {
  await Promise.all([messaging?.stop(), billing?.stop()]);
});

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
