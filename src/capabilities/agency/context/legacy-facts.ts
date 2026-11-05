// The pre-C1 vector rows remain intact. Curator only adds supersession metadata;
// the complete original payload is retained in its own reversible change ledger.
import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import { mem0CollectionTable } from '@/kernel/records/mem0-collection';
import type { FactT } from './topic-contract';

function collection() {
  const name = mem0CollectionTable();
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('invalid memory collection');
  return sql.raw(`"${name}"`);
}
export type LegacyFact = {
  id: string;
  body: string;
  memory_kind: FactT['memory_kind'];
  evidence_ids: string[];
  payload: Record<string, unknown>;
};
export async function readLegacyFacts(db: Db | Tx): Promise<LegacyFact[]> {
  const [exists] = await db.execute<{ present: boolean }>(
    sql`SELECT to_regclass(${mem0CollectionTable()}) IS NOT NULL AS present`,
  );
  if (!exists?.present) return [];
  const rows = await db.execute<{ id: string; payload: Record<string, unknown> }>(sql`
    SELECT id::text, payload FROM ${collection()}
    WHERE payload->>'user_id' = 'self'
      AND NOT (payload ? 'superseded_by') ORDER BY id`);
  const refs = rows.flatMap((r) =>
    typeof r.payload.event_id === 'string' ? [r.payload.event_id] : [],
  );
  const allowed = await allowedEventIds(db, refs);
  return rows.flatMap((r) => {
    const p = r.payload;
    if (typeof p.event_id !== 'string' || !allowed.has(p.event_id) || typeof p.data !== 'string')
      return [];
    const kind = p.kind;
    return [
      {
        id: `mem0:${r.id}`,
        body: p.data,
        payload: p,
        evidence_ids: [p.event_id],
        memory_kind:
          kind === 'preference' || kind === 'habit' || kind === 'weakness' ? kind : 'event',
      },
    ];
  });
}
export async function supersedeLegacy(tx: Tx, fact: LegacyFact, changeId: string) {
  const rows = await tx.execute(sql`UPDATE ${collection()} SET payload = payload ||
    jsonb_build_object('superseded_by', ${changeId}::text, 'invalid_at', ${new Date().toISOString()}::text)
    WHERE id = ${fact.id.slice(5)}::uuid AND payload = ${JSON.stringify(fact.payload)}::jsonb RETURNING id`);
  if (rows.length !== 1) throw new Error('legacy fact changed; reload');
}
export async function restoreLegacy(tx: Tx, snapshots: LegacyFact[], changeId: string) {
  for (const fact of snapshots) {
    const rows =
      await tx.execute(sql`UPDATE ${collection()} SET payload = ${JSON.stringify(fact.payload)}::jsonb
      WHERE id = ${fact.id.slice(5)}::uuid AND payload->>'superseded_by' = ${changeId} RETURNING id`);
    if (rows.length !== 1) throw new Error('legacy fact has later changes; cannot undo');
  }
}
