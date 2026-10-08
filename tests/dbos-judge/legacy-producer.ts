// Compiled against a sealed, real pre-0118 source tree by cutover.db.test.ts.
import { z } from 'zod';
import { CreateSubmissionBodySchema } from '@/capabilities/practice/api/assessment-contracts';
import { dispatchNativeAttempt } from '@/capabilities/practice/server/assessment/durable-attempt';
import { NativeJudgePendingSubmitInput } from '@/core/schema/event/judge-pending-events';
import { db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';

async function main() {
  const url = new URL(z.url().parse(process.env.DATABASE_URL));
  if (
    process.env.TLP_JUDGE_OLD_PRODUCER !== '1' ||
    !/^\/test_fork_\d+$/.test(url.pathname) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Disposable old producer required');
  const boss = await getStartedBoss();
  await boss.createQueue('judge_run');
  if (process.env.TLP_JUDGE_OLD_PAUSE_BEFORE_SEND === '1') {
    const adapter = boss.getDb(),
      execute = adapter.executeSql.bind(adapter);
    let paused = false;
    adapter.executeSql = async (text, values) => {
      if (
        !paused &&
        text.includes('INSERT INTO pgboss.') &&
        values?.some((value) => value === 'judge_run')
      ) {
        paused = true;
        process.send?.({ kind: 'before-send', pid: process.pid, sql: text });
        process.kill(process.pid, 'SIGSTOP');
      }
      return execute(text, values);
    };
  }

  process.send?.({ kind: 'ready', pid: process.pid, revision: process.env.TLP_JUDGE_OLD_REVISION });
  process.on('message', async (raw) => {
    try {
      const command = z
        .discriminatedUnion('kind', [
          z.object({
            kind: z.literal('dispatch'),
            questionId: z.string(),
            request: z.unknown(),
            capture: NativeJudgePendingSubmitInput.shape.capture,
          }),
          z.object({ kind: z.literal('stop') }),
        ])
        .parse(raw);
      if (command.kind === 'stop') {
        await boss.stop();
        await db.$client.end();
        process.exit(0);
      }
      const request = CreateSubmissionBodySchema.extend({ now: z.coerce.date().optional() }).parse(
        command.request,
      );
      const runId = await dispatchNativeAttempt(
        db,
        command.questionId,
        request,
        { enabled: true, capture: command.capture },
        {
          boss: {
            send: (name, data, options) =>
              boss.send(name, z.record(z.string(), z.unknown()).parse(data), options),
          },
        },
      );
      process.send?.({ kind: 'dispatched', runId });
    } catch (error) {
      process.send?.({ kind: 'rejected', error: String(error) });
    }
  });
}
main().catch((error) => {
  process.send?.({ kind: 'failure', error: String(error) });
  process.exit(1);
});
