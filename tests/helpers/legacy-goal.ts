import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';
import type { InsertGoalInput } from '@/kernel/records/goal-commands';

/** Raw legacy fixture only. Production mutations require canonical migration first. */
export async function insertLegacyGoal(db: Db | Tx, input: InsertGoalInput): Promise<string> {
  const { now = new Date(), ...fields } = input;
  await db.insert(goal).values({ ...fields, created_at: now, updated_at: now, version: 0 });
  return input.id;
}
