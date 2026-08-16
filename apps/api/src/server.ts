import { buildApp } from './app.js';
import { env } from './env.js';

const app = buildApp();

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
