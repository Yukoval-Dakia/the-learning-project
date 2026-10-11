import { DBOS } from '@dbos-inc/dbos-sdk';
import type { PgBoss } from 'pg-boss';
import { observabilityCapability } from '@/capabilities/observability/manifest';

export const pruneFamily = 'prune_job_events';
export const schedulerPollMs = 100;
export const clockSearchPath = 'prune_cron_clock, pg_catalog, public';

function declaration(name: string) {
  const job = observabilityCapability.jobs?.handlers?.find((job) => job.name === name);
  if (!job?.schedule) throw new Error(`Missing production schedule for ${name}`);
  return { ...job, schedule: job.schedule };
}

export const pruneDeclarations = {
  pruneEvents: declaration('prune_job_events'),
  reviewOrphans: declaration('prune_orphan_review_sessions'),
  conversationOrphans: declaration('prune_orphan_conversation_sessions'),
  placementOrphans: declaration('prune_orphan_placement_sessions'),
};

export function acceleratePruneCron(boss: PgBoss) {
  function validate(name: string, cron: string, timezone: string | undefined) {
    const production = declaration(name).schedule;
    if (cron !== production.cron || timezone !== production.tz)
      throw new Error(`Fixture received a different production schedule for ${name}`);
  }
  const schedule = boss.schedule.bind(boss);
  boss.schedule = (name, cron, data, options) => {
    if (name !== pruneFamily) return schedule(name, cron, data, options);
    validate(name, cron, options?.tz);
    return schedule(name, '* * * * *', data, options);
  };
  const configure = DBOS.setConfig.bind(DBOS);
  DBOS.setConfig = (config) =>
    configure({ ...config, schedulerPollingIntervalMs: schedulerPollMs });
  const apply = DBOS.applySchedules.bind(DBOS);
  const resume = DBOS.resumeSchedule.bind(DBOS);
  let stopping = false;
  let nativePoint: Date | undefined;
  DBOS.applySchedules = (schedules) => {
    const effective = schedules
      .filter(
        (schedule) =>
          schedule.scheduleName !== pruneFamily || (!stopping && nativePoint !== undefined),
      )
      .map((schedule) => {
        if (schedule.scheduleName !== pruneFamily) return schedule;
        validate(schedule.scheduleName, schedule.schedule, schedule.cronTimezone);
        if (!nativePoint) throw new Error('Native point must be armed before scheduling');
        const cron = [
          nativePoint.getUTCSeconds(),
          nativePoint.getUTCMinutes(),
          nativePoint.getUTCHours(),
          nativePoint.getUTCDate(),
          nativePoint.getUTCMonth() + 1,
          '*',
        ].join(' ');
        return { ...schedule, schedule: cron, cronTimezone: 'UTC' };
      });
    return effective.length ? apply(effective) : Promise.resolve();
  };
  DBOS.resumeSchedule = (name) =>
    (stopping || !nativePoint) && name === pruneFamily ? Promise.resolve() : resume(name);
  return {
    arm(at: Date) {
      if (nativePoint || at.getTime() <= Date.now())
        throw new Error('Native cron requires one future point');
      nativePoint = at;
    },
    async pause() {
      stopping = true;
      if (await DBOS.getSchedule(pruneFamily)) await DBOS.pauseSchedule(pruneFamily);
    },
  };
}
