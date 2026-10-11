import { DBOS } from '@dbos-inc/dbos-sdk';
import type { PgBoss } from 'pg-boss';
import { observabilityCapability } from '@/capabilities/observability/manifest';

export const reviewFamily = 'prune_orphan_review_sessions';
export const nativeCron = '*/2 * * * * *';
export const schedulerPollMs = 100;
export const clockSearchPath = 'review_cron_clock, pg_catalog, public';

function declaration(name: string) {
  const job = observabilityCapability.jobs?.handlers?.find((job) => job.name === name);
  if (!job?.schedule) throw new Error(`Missing production schedule for ${name}`);
  return { ...job, schedule: job.schedule };
}

export const reviewDeclarations = {
  pruneEvents: declaration('prune_job_events'),
  reviewOrphans: declaration('prune_orphan_review_sessions'),
  conversationOrphans: declaration('prune_orphan_conversation_sessions'),
  placementOrphans: declaration('prune_orphan_placement_sessions'),
};

// Only the cadence changes. The real backends still register the production declarations.
export function accelerateReviewCron(boss: PgBoss) {
  const reported = new Set<string>();
  function report(backend: string, name: string, cron: string, tz: string | undefined) {
    const production = declaration(name).schedule;
    if (!production || cron !== production.cron || tz !== production.tz)
      throw new Error(`Fixture received a different production schedule for ${name}`);
    const key = `${backend}/${name}`;
    if (!reported.has(key)) {
      reported.add(key);
      process.send?.({
        kind: 'cron-registration',
        pid: process.pid,
        backend,
        name,
        production,
        effectiveCron: backend === 'dbos' ? nativeCron : '* * * * *',
        at: new Date().toISOString(),
      });
    }
  }
  const schedule = boss.schedule.bind(boss);
  boss.schedule = (name, cron, data, options) => {
    if (name !== reviewFamily) return schedule(name, cron, data, options);
    report('pg-boss', name, cron, options?.tz);
    return schedule(name, '* * * * *', data, options);
  };
  const configure = DBOS.setConfig.bind(DBOS);
  DBOS.setConfig = (config) =>
    configure({ ...config, schedulerPollingIntervalMs: schedulerPollMs });
  const apply = DBOS.applySchedules.bind(DBOS);
  const resume = DBOS.resumeSchedule.bind(DBOS);
  let stopping = false;
  DBOS.applySchedules = (schedules) => {
    const effective = schedules
      .filter((schedule) => !stopping || schedule.scheduleName !== reviewFamily)
      .map((schedule) => {
        if (schedule.scheduleName !== reviewFamily) return schedule;
        report('dbos', schedule.scheduleName, schedule.schedule, schedule.cronTimezone);
        return { ...schedule, schedule: nativeCron };
      });
    return effective.length ? apply(effective) : Promise.resolve();
  };
  DBOS.resumeSchedule = (name) =>
    stopping && name === reviewFamily ? Promise.resolve() : resume(name);
  const status = DBOS.getWorkflowStatus.bind(DBOS);
  DBOS.getWorkflowStatus = async (workflowId) => {
    const result = await status(workflowId);
    if (workflowId.startsWith(`sched-${reviewFamily}-`))
      process.send?.({
        kind: 'native-scheduler-probe',
        pid: process.pid,
        workflowId,
        status: result?.status ?? null,
        at: new Date().toISOString(),
      });
    return result;
  };
  return async () => {
    stopping = true;
    if (await DBOS.getSchedule(reviewFamily)) await DBOS.pauseSchedule(reviewFamily);
  };
}
