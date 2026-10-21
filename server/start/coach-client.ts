import type { CoachWeeklyReader } from '@/capabilities/shell/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartCoachWeekly } from './coach-function';

export const startCoachWeeklyClient: CoachWeeklyReader = async (days, timeZone) =>
  JSON.parse(
    await getStartCoachWeekly({
      fetch: authenticatedStartFetch,
      data: { days: String(days), timezone: timeZone },
    }),
  );
