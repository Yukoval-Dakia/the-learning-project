// Display labels for stored misc_ cause ids. A misc id is a promoted misconception
// node; rendering surfaces hold only the id, so resolve titles by id and keep the id
// in the original field. Kernel cannot import the capability, so it reads the table
// directly.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { misconception } from '@/db/schema';

/**
 * Prefix for promoted misconception node ids; the practice-side generator uses the
 * same wire value.
 */
export const MISC_CAUSE_ID_PREFIX = 'misc_';

export function isMiscCauseId(causeId: string): boolean {
  return causeId.startsWith(MISC_CAUSE_ID_PREFIX);
}

/**
 * misc id -> active, unarchived misconception title. Missing entries fall back to
 * the raw id; non-misc ids are profile vocabulary.
 */
export async function resolveMiscCauseLabels(
  db: Db | Tx,
  causeIds: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(causeIds.filter(isMiscCauseId))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: misconception.id, title: misconception.title })
    .from(misconception)
    .where(
      and(
        inArray(misconception.id, wanted),
        eq(misconception.status, 'active'),
        isNull(misconception.archived_at),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.title]));
}

/**
 * Narrow resolved labels to a Record for the wire; vocabulary ids and unresolvable
 * misc ids are absent. A keyed map survives filtering and reordering.
 */
export function miscCauseLabelMap(
  labels: ReadonlyMap<string, string>,
  causeIds: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of causeIds) {
    const label = labels.get(id);
    if (label !== undefined) out[id] = label;
  }
  return out;
}
