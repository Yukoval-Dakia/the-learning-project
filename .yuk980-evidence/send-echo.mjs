// YUK-980 built-artifact QA helper — enqueue one real echo job through a
// throwaway pg-boss sender (same pattern as an app-process enqueue; never
// work()s, so it never competes with the worker under test).
import { PgBoss } from 'pg-boss';

const businessId = process.argv[2];
if (!businessId) throw new Error('usage: node send-echo.mjs <businessId> <input>');
const input = process.argv[3] ?? 'abcd';

const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schema: 'pgboss' });
await boss.start();
await boss.send('echo', { businessId, input });
console.log(`sent echo job businessId=${businessId} input=${input}`);
await boss.stop({ graceful: false, timeout: 1_000 });
process.exit(0);
