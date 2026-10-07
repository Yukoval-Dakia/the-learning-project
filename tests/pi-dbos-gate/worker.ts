import { DBOS } from '@dbos-inc/dbos-sdk';
import postgres from 'postgres';
import { z } from 'zod';
import { jobSchema, registerGateWorkflow } from './workflow';

const config = z
  .object({
    url: z.url(),
    mode: z.enum(['start', 'recover']),
    job: jobSchema,
    pauseAt: z.string(),
    codeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .parse({
    url: process.env.TLP_GATE_DATABASE_URL,
    mode: process.argv[2],
    job: JSON.parse(process.env.TLP_GATE_JOB ?? 'null'),
    pauseAt: process.env.TLP_GATE_PAUSE_AT ?? '',
    codeDigest: process.env.TLP_GATE_CODE_DIGEST,
  });
const target = new URL(config.url);
if (
  process.env.TLP_GATE_TEST_PROCESS !== '1' ||
  !/^\/test_fork_\d+$/.test(target.pathname) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
) {
  throw new Error('Gate worker requires the scoped Testcontainers fork database');
}

const sql = postgres(config.url, { max: 2 });
const workflow = registerGateWorkflow(sql, async (boundary, turn) => {
  if (turn !== 0 || config.pauseAt !== boundary) return;
  process.send?.({ kind: 'boundary', boundary, pid: process.pid });
  await new Promise<void>((resolve) => process.once('message', () => resolve()));
});
DBOS.setConfig({
  name: 'yuk1338-isolated-gate',
  systemDatabaseUrl: config.url,
  systemDatabaseSchemaName: 'yuk1338_dbos',
  executorID: 'local',
  applicationVersion: `yuk1338-${config.codeDigest}`,
  systemDatabasePoolSize: 3,
  enableOTLP: false,
  tracingEnabled: false,
  logLevel: 'ERROR',
});

try {
  await DBOS.launch();
  const handle =
    config.mode === 'start'
      ? await DBOS.startWorkflow(workflow, { workflowID: config.job.workflowId })(config.job)
      : DBOS.retrieveWorkflow(config.job.workflowId);
  const result = await handle.getResult();
  const steps = await DBOS.listWorkflowSteps(config.job.workflowId);
  const status = await handle.getStatus();
  process.send?.({ kind: 'done', pid: process.pid, result, steps, status });
} catch (error) {
  process.send?.({
    kind: 'failure',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  await DBOS.shutdown();
  await sql.end();
  process.disconnect?.();
}
