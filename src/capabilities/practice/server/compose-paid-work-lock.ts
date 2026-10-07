import type { Db } from '@/db/client';
import { withinSessionAdvisoryLock } from '@/db/session-advisory-lock';
import { ApiError } from '@/kernel/http';

export const DEFAULT_COMPOSE_LOCK_WAIT_MS = 30_000;

export async function withinComposePaidWorkLock<T>(
  db: Db,
  date: string,
  deadlineAt: Date,
  work: (lockedDb: Db) => Promise<T>,
): Promise<T> {
  return withinSessionAdvisoryLock(
    db,
    {
      key: `stream:compose-paid:${date}`,
      busy: () =>
        new ApiError(
          'practice_compose_busy',
          'Practice stream compose is busy; retry the request',
          503,
          { 'Retry-After': '1' },
        ),
    },
    deadlineAt,
    work,
  );
}
