// Parent-owned, loopback-only Start acceptance entry. Run only after obtaining
// the runtime lock and explicitly supplying an isolated acceptance DB/token.
// Does not load .env, start workers/listeners for events, recover jobs, or call AI.
import { serve } from '@hono/node-server';
import { capabilities } from '@/capabilities';
import { getServerEnv, requireApiInternalToken, resolveApiPort } from '@/server/config/env';
import { buildHonoApp } from '../app';
import { assertComposedRoutesDeclared } from '../composed-routes';
import { createFrontdoor } from '../frontdoor';

const env = getServerEnv();
requireApiInternalToken(env);
const port = resolveApiPort(env.API_PORT);
const [{ installPracticeHostOperations }, { installModelAdmissionPins }] = await Promise.all([
  import('@/capabilities/practice/public'),
  import('@/server/assessment/model-admission-pins'),
]);
await installPracticeHostOperations();
await installModelAdmissionPins();
const [{ buildAdminConfigRuntimeFacts }, { setAdminConfigRuntimeFacts }] = await Promise.all([
  import('@/server/config/admin-config-facts'),
  import('@/capabilities/observability/public'),
]);
setAdminConfigRuntimeFacts(buildAdminConfigRuntimeFacts);
assertComposedRoutesDeclared(capabilities);
const fetch = await createFrontdoor(buildHonoApp(capabilities));
const server = serve({ fetch, hostname: '127.0.0.1', port });

async function stop() {
  server.close();
  if ('closeAllConnections' in server) server.closeAllConnections();
  const { db } = await import('@/db/client');
  await db.$client.end({ timeout: 3 });
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
