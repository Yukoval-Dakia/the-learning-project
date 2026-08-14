export { updateGoalScope } from '@/capabilities/agency/public';
export { getEffectiveDomain } from '@/capabilities/knowledge/public';
export { buildTavilyMcpServer } from '@/server/ai/mcp/tavily';
export type { QuizGenJobData } from '@/server/boss/handlers/quiz_gen';
export { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';
export { JOB_RETRY_DELAY_SECONDS, JOB_RETRY_LIMIT } from '@/server/boss/queue-config';
export { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
export { knowledgeRowToSnapshot } from '@/server/projections/snapshot-mappers';

export async function getStartedQuestionSupplyBoss() {
  const { getStartedBoss } = await import('@/server/boss/client');
  return getStartedBoss();
}
