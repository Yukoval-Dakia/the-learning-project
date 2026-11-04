import { readFile } from 'node:fs/promises';
import { QuestionPreparerJobData } from '@/capabilities/practice/supply/server/question-preparer';
import { getStartedBoss } from '@/server/boss/client';
import { DEV_DATABASE_PATTERN, devDatabaseName } from './dev-worktree-db';

async function main() {
  if (
    process.env.NODE_ENV !== 'development' ||
    !process.env.DATABASE_URL ||
    new URL(process.env.DATABASE_URL).port !== '5434'
  ) {
    throw new Error('Manual preparer requires the DEV database on port 5434');
  }
  const targetDatabase = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1));
  if (!DEV_DATABASE_PATTERN.test(targetDatabase) || targetDatabase !== devDatabaseName()) {
    throw new Error('Manual preparer must use this worktree dev database');
  }
  const [path] = process.argv.slice(2);
  if (!path) throw new Error('Usage: tsx scripts/question-preparer-run.ts <job-data.json>');
  const data = QuestionPreparerJobData.parse(JSON.parse(await readFile(path, 'utf8')));
  if (data.continuation && !data.continuation.simulated) {
    throw new Error('Manual repair verdicts must be marked simulated until the gate hook-up lands');
  }
  const boss = await getStartedBoss();
  const jobId = await boss.send('question_preparer_run', data);
  console.log(
    JSON.stringify({ job_id: jobId, demand_id: data.ticket.demand_id, database_port: 5434 }),
  );
  await boss.stop();
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
