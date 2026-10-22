import type {
  CoachCalibrationReader,
  CoachEffectivenessReader,
  CoachWeeklyReader,
} from '@/capabilities/shell/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import {
  getStartCoachCalibration,
  getStartCoachEffectiveness,
  getStartCoachWeekly,
} from './coach-function';

export const startCoachWeeklyClient: CoachWeeklyReader = async (days, timeZone) =>
  JSON.parse(
    await getStartCoachWeekly({
      fetch: authenticatedStartFetch,
      data: { days: String(days), timezone: timeZone },
    }),
  );

export const startCoachCalibrationClient: CoachCalibrationReader = async () =>
  JSON.parse(await getStartCoachCalibration({ fetch: authenticatedStartFetch }));

export const startCoachEffectivenessClient: CoachEffectivenessReader = async () =>
  JSON.parse(await getStartCoachEffectiveness({ fetch: authenticatedStartFetch }));
