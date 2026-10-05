import type { Db } from '@/db/client';
import { KNOWN_SUBJECT_IDS, subjectProfiles } from '@/subjects/profile';
import { createKnowledgeNodeFromEvents } from './node-creation';

export interface SeedResult {
  inserted: number;
  skipped: number;
}

/** Seed only builtin subject roots, never curriculum children. Keep IDs/provenance stable.
 * Repeated or concurrent bootstrap skips existing roots without manufacturing new history.
 */
export async function seedKnowledge(db: Db): Promise<SeedResult> {
  let inserted = 0;
  let skipped = 0;
  for (const subjectId of KNOWN_SUBJECT_IDS) {
    const didInsert = await db.transaction((tx) =>
      createKnowledgeNodeFromEvents(
        tx,
        {
          id: `seed:${subjectId}:root`,
          name: subjectProfiles[subjectId]?.displayName ?? subjectId,
          domain: subjectId,
          parent_id: null,
          proposed_by_ai: false,
          created_at: new Date(),
        },
        { actorRef: 'knowledge-seed' },
        'skip',
      ),
    );
    if (didInsert) inserted += 1;
    else skipped += 1;
  }
  return { inserted, skipped };
}
