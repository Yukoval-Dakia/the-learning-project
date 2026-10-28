/**
 * YUK-1600 ops CLI — one-time identity-role backfill for existing knowledge nodes.
 *
 * Stock repair (deterministic predicates, no judgment calls):
 *   - seed containers: id ~ '^seed:[^:]+:root$'            → role 'container'
 *   - LearningIntent 3a roots: the single knowledge id carried by a hub learning_item
 *     (source='learning_intent', parent_learning_item_id IS NULL, exactly one id) whose
 *     node was BORN from the learning-intent accept path (genesis event actor_ref
 *     'learning-intent-accept'). 3b/3c roots pre-existed and keep their identity.
 *
 * Each repair is written as an `experimental:knowledge_role_update` control-plane event
 * and projected through the canonical fold in the same transaction — never raw SQL —
 * so a later node re-projection reproduces the role instead of reverting it. Ids are
 * never minted or renamed; mastery_state / material_fsrs_state evidence rows are not
 * touched (the read/write gates hide them for non-kc nodes, evidence stays inspectable).
 *
 * Idempotent: a node already carrying its target role is reported and skipped.
 * The run prints a JSON repair receipt to stdout (per-node from→to, verification of
 * id preservation and evidence-row preservation).
 *
 * Usage: pnpm ops:yuk1600-backfill-knowledge-roles [--dry-run]
 */

import './load-env';

import { and, eq, isNull, sql } from 'drizzle-orm';
import { requireKnowledgeHistory } from '@/capabilities/knowledge/server/node-history-guard';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { db } from '@/db/client';
import { knowledge, mastery_state, material_fsrs_state } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { projectKnowledgeNodeGuarded } from '@/kernel/records/knowledge-node-materialization';

const ACTOR_REF = 'ops:yuk1600-knowledge-role-backfill';
const SEED_ROOT_PATTERN = '^seed:[^:]+:root$';

type RepairTarget = {
  id: string;
  name: string;
  from: string;
  to: 'container' | 'goal';
  basis: 'seed_container' | 'learning_intent_root';
};

interface EvidenceSnapshot {
  mastery_rows: number;
  fsrs_rows: number;
}

async function evidenceSnapshot(db: Db, id: string): Promise<EvidenceSnapshot> {
  const [mastery] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mastery_state)
    .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, id)));
  const [fsrs] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, 'knowledge'),
        eq(material_fsrs_state.subject_id, id),
      ),
    );
  return { mastery_rows: mastery?.count ?? 0, fsrs_rows: fsrs?.count ?? 0 };
}

/** Deterministic repair set. Pure derivation — no writes. */
async function deriveTargets(db: Db): Promise<RepairTarget[]> {
  const targets = new Map<string, RepairTarget>();

  const seedRows = await db
    .select({ id: knowledge.id, name: knowledge.name, role: knowledge.role })
    .from(knowledge)
    .where(sql`${knowledge.id} ~ ${SEED_ROOT_PATTERN}`);
  for (const row of seedRows) {
    targets.set(row.id, {
      id: row.id,
      name: row.name,
      from: row.role,
      to: 'container',
      basis: 'seed_container',
    });
  }

  // Hub learning items reference exactly the topic root; the genesis-actor EXISTS clause
  // keeps only roots CREATED by the accept path (3a). A 3b/3c root pre-existed with its
  // own genesis actor and is deliberately not re-identified.
  const liRoots = await db.execute<{ id: string; name: string; role: string }>(sql`
    SELECT k.id, k.name, k.role
    FROM learning_item li
    JOIN knowledge k ON k.id = li.knowledge_ids ->> 0
    WHERE li.source = 'learning_intent'
      AND li.parent_learning_item_id IS NULL
      AND jsonb_array_length(li.knowledge_ids) = 1
      AND EXISTS (
        SELECT 1 FROM event e
        WHERE e.action = 'experimental:genesis'
          AND e.subject_kind = 'knowledge'
          AND e.subject_id = k.id
          AND e.actor_ref = 'learning-intent-accept'
      )
  `);
  for (const row of liRoots) {
    if (targets.has(row.id)) continue;
    targets.set(row.id, {
      id: row.id,
      name: row.name,
      from: row.role,
      to: 'goal',
      basis: 'learning_intent_root',
    });
  }
  return [...targets.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

async function applyRepair(tx: Tx, target: RepairTarget): Promise<void> {
  // Row lock + fresh read: serialize with any concurrent node writer and stamp the
  // version the fold will actually see.
  const [node] = await tx
    .select()
    .from(knowledge)
    .where(and(eq(knowledge.id, target.id), isNull(knowledge.archived_at)))
    .limit(1)
    .for('update');
  if (!node) throw new Error(`knowledge ${target.id} missing or archived — repair aborted`);
  if (node.role === target.to) return; // raced to done or already repaired
  await requireKnowledgeHistory(tx, node);

  const now = new Date();
  await writeEvent(tx, {
    id: newId(),
    session_id: null,
    actor_kind: 'system',
    actor_ref: ACTOR_REF,
    action: 'experimental:knowledge_role_update',
    subject_kind: 'knowledge',
    subject_id: node.id,
    outcome: 'success',
    payload: {
      role: target.to,
      previous_role: node.role,
      reason: `YUK-1600 stock repair (${target.basis}): non-kc identity, mastery not evaluated`,
      previous_version: node.version,
      next_version: node.version + 1,
    },
    // Control-plane identity repair, not learner evidence: keep it out of the
    // memory/brief outbox.
    ingest_at: now,
    created_at: now,
  });
  await projectKnowledgeNodeGuarded(tx, node.id);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const targets = await deriveTargets(db);
  const pending = targets.filter((t) => t.from !== t.to);
  const alreadyDone = targets.filter((t) => t.from === t.to);

  const evidenceBefore = new Map<string, EvidenceSnapshot>();
  for (const t of targets) {
    evidenceBefore.set(t.id, await evidenceSnapshot(db, t.id));
  }

  if (!dryRun) {
    for (const target of pending) {
      await db.transaction((tx) => applyRepair(tx, target));
    }
  }

  // Receipt: verify id preservation (same node id, live row present), role outcome, and
  // untouched evidence rows. 历史证据不丢 is the load-bearing acceptance check.
  const repaired: Array<Record<string, unknown>> = [];
  let verificationOk = true;
  for (const t of pending) {
    const [after] = await db
      .select({ id: knowledge.id, role: knowledge.role })
      .from(knowledge)
      .where(eq(knowledge.id, t.id))
      .limit(1);
    const evidenceAfter = await evidenceSnapshot(db, t.id);
    const before = evidenceBefore.get(t.id);
    const evidencePreserved =
      evidenceAfter.mastery_rows === before?.mastery_rows &&
      evidenceAfter.fsrs_rows === before?.fsrs_rows;
    const roleApplied = dryRun ? after?.role === t.from : after?.role === t.to;
    const ok = after?.id === t.id && roleApplied && evidencePreserved;
    if (!ok) verificationOk = false;
    repaired.push({
      id: t.id,
      name: t.name,
      basis: t.basis,
      from_role: t.from,
      to_role: dryRun ? null : t.to,
      id_preserved: after?.id === t.id,
      mastery_state_rows_before: before?.mastery_rows ?? 0,
      mastery_state_rows_after: evidenceAfter.mastery_rows,
      material_fsrs_state_rows_before: before?.fsrs_rows ?? 0,
      material_fsrs_state_rows_after: evidenceAfter.fsrs_rows,
      verified: ok,
    });
  }

  const receipt = {
    operation: 'yuk1600_knowledge_role_backfill',
    actor_ref: ACTOR_REF,
    dry_run: dryRun,
    derived_targets: targets.length,
    already_at_target: alreadyDone.length,
    repaired: dryRun ? 0 : pending.length,
    would_repair: dryRun ? pending.length : 0,
    by_target_role: {
      container: targets.filter((t) => t.to === 'container').length,
      goal: targets.filter((t) => t.to === 'goal').length,
    },
    verification_ok: verificationOk,
    nodes: repaired,
  };
  console.log(JSON.stringify(receipt, null, 2));
  if (!verificationOk) {
    console.error('receipt verification failed — see nodes[].verified=false entries');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
