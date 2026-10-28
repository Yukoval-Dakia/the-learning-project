/**
 * YUK-1604 ops CLI — stock repair of historical mis-classified knowledge roots,
 * beyond the YUK-1600 (1421-1) role backfill.
 *
 * Deterministic repair classes (no judgment calls; ids and evidence rows untouched):
 *   - A. role repair: placement starter anchors (`placement-starter:<subject>`) are
 *     structural per-subject scope anchors born role='kc' (domain NULL, parented under
 *     the subject root) → 'container'. 起点测评 is not a testable knowledge point, so
 *     after YUK-1600's read/write gates it must stop carrying θ/PFA/FSRS readings.
 *   - B. approval repair: nodes born from `experimental:auto_tag_kc_created` events
 *     whose payload predates the YUK-1405 'pending' arming (no approval_status field
 *     ⇒ fold projects 'approved') and that sit in the owner's await-confirmation
 *     bucket — effective domain unresolved OR parent carries a non-kc role →
 *     approval_status 'pending' (等确认, not auto-passed).
 *
 * Each repair is written as a control-plane event (`experimental:knowledge_role_update`
 * / `experimental:knowledge_approval_update`) and projected through the canonical fold
 * in the same transaction — never raw SQL — so a later re-projection reproduces it.
 * LearningIntent one-step-accepted KCs, seeds and accepted proposals are NOT in the
 * derived set: their genesis actor is not 'tag_knowledge' / their id is not a starter
 * anchor, so 拍板 #2's「其余不变 / 不影响一步审批」holds by construction.
 *
 * Idempotent: a node already carrying its target state is reported and skipped.
 * The run prints a JSON repair receipt to stdout (per-node from→to + basis, evidence
 * row preservation, id preservation). Historical mastery/FSRS evidence rows are never
 * deleted — the role/approval markers are truthful metadata; gates hide non-kc reads.
 *
 * Usage: pnpm ops:yuk1604-repair-knowledge-classification [--dry-run]
 */

import './load-env';

import { and, eq, isNull, sql } from 'drizzle-orm';
import { requireKnowledgeHistory } from '@/capabilities/knowledge/server/node-history-guard';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { db } from '@/db/client';
import { knowledge, mastery_state, material_fsrs_state } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { projectKnowledgeNodeGuarded } from '@/kernel/records/knowledge-node-materialization';

const ACTOR_REF = 'ops:yuk1604-knowledge-classification-repair';

type RoleRepair = {
  kind: 'role';
  id: string;
  name: string;
  from: string;
  to: 'container';
  basis: 'placement_starter_anchor';
};

type ApprovalRepair = {
  kind: 'approval';
  id: string;
  name: string;
  from: 'approved';
  to: 'pending';
  basis: 'domain_unresolved' | 'parent_non_kc' | 'domain_unresolved+parent_non_kc';
};

type RepairTarget = RoleRepair | ApprovalRepair;

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

  // Class A — placement starter anchors typed as testable KCs.
  const anchors = await db
    .select({ id: knowledge.id, name: knowledge.name, role: knowledge.role })
    .from(knowledge)
    .where(and(sql`${knowledge.id} LIKE 'placement-starter:%'`, isNull(knowledge.archived_at)));
  for (const row of anchors) {
    if (row.role !== 'kc') continue; // already repaired
    targets.set(row.id, {
      kind: 'role',
      id: row.id,
      name: row.name,
      from: row.role,
      to: 'container',
      basis: 'placement_starter_anchor',
    });
  }

  // Class B — pre-pending auto-tag births still projected 'approved' (owner rule:
  // unresolved effective domain OR non-kc parent ⇒ await confirmation).
  const births = await db.execute<{ id: string; name: string; parent_id: string | null }>(sql`
    SELECT k.id, k.name, k.parent_id
    FROM knowledge k
    JOIN event e
      ON e.action = 'experimental:auto_tag_kc_created'
     AND e.subject_kind = 'knowledge'
     AND e.subject_id = k.id
    WHERE k.archived_at IS NULL
      AND k.approval_status = 'approved'
      AND e.payload ->> 'approval_status' IS NULL
  `);
  for (const row of births) {
    if (targets.has(row.id)) continue;
    let parentRole: string | null = null;
    if (row.parent_id !== null) {
      const [parent] = await db
        .select({ role: knowledge.role })
        .from(knowledge)
        .where(eq(knowledge.id, row.parent_id))
        .limit(1);
      parentRole = parent?.role ?? null;
    }
    let domain: string | null = null;
    try {
      domain = await getEffectiveDomain(db, row.id);
    } catch {
      domain = null; // orphan / null-root domain chain
    }
    const domainUnresolved = domain === null;
    const parentNonKc = parentRole !== 'kc';
    if (!domainUnresolved && !parentNonKc) continue; // 其余不变 — stays as projected
    targets.set(row.id, {
      kind: 'approval',
      id: row.id,
      name: row.name,
      from: 'approved',
      to: 'pending',
      basis:
        domainUnresolved && parentNonKc
          ? 'domain_unresolved+parent_non_kc'
          : domainUnresolved
            ? 'domain_unresolved'
            : 'parent_non_kc',
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
  await requireKnowledgeHistory(tx, node);

  const now = new Date();
  if (target.kind === 'role') {
    if (node.role === target.to) return; // raced to done or already repaired
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
        reason: `YUK-1604 stock repair (${target.basis}): structural placement anchor, not a testable KC — mastery not evaluated`,
        previous_version: node.version,
        next_version: node.version + 1,
      },
      // Control-plane repair, not learner evidence: keep it out of the memory outbox.
      ingest_at: now,
      created_at: now,
    });
  } else {
    if (node.approval_status === target.to) return;
    if (node.approval_status !== 'approved') {
      throw new Error(
        `knowledge ${node.id} approval_status='${node.approval_status}' — only approved→pending stock repair is allowed`,
      );
    }
    await writeEvent(tx, {
      id: newId(),
      session_id: null,
      actor_kind: 'system',
      actor_ref: ACTOR_REF,
      action: 'experimental:knowledge_approval_update',
      subject_kind: 'knowledge',
      subject_id: node.id,
      outcome: 'success',
      payload: {
        approval_status: target.to,
        previous_approval_status: node.approval_status,
        reason: `YUK-1604 stock repair (${target.basis}): agent-minted KC predates pending arming — await confirmation, never auto-passed`,
        previous_version: node.version,
        next_version: node.version + 1,
      },
      ingest_at: now,
      created_at: now,
    });
  }
  await projectKnowledgeNodeGuarded(tx, node.id);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const targets = await deriveTargets(db);

  const evidenceBefore = new Map<string, EvidenceSnapshot>();
  for (const t of targets) {
    evidenceBefore.set(t.id, await evidenceSnapshot(db, t.id));
  }

  if (!dryRun) {
    for (const target of targets) {
      await db.transaction((tx) => applyRepair(tx, target));
    }
  }

  // Receipt: verify id preservation (same node id, live row present), target state
  // outcome, and untouched evidence rows. 历史证据不丢 is the load-bearing check.
  const nodes: Array<Record<string, unknown>> = [];
  let verificationOk = true;
  for (const t of targets) {
    const [after] = await db
      .select({
        id: knowledge.id,
        role: knowledge.role,
        approval_status: knowledge.approval_status,
      })
      .from(knowledge)
      .where(eq(knowledge.id, t.id))
      .limit(1);
    const evidenceAfter = await evidenceSnapshot(db, t.id);
    const before = evidenceBefore.get(t.id);
    const evidencePreserved =
      evidenceAfter.mastery_rows === before?.mastery_rows &&
      evidenceAfter.fsrs_rows === before?.fsrs_rows;
    const stateApplied = dryRun
      ? t.kind === 'role'
        ? after?.role === t.from
        : after?.approval_status === t.from
      : t.kind === 'role'
        ? after?.role === t.to
        : after?.approval_status === t.to;
    const ok = after?.id === t.id && stateApplied && evidencePreserved;
    if (!ok) verificationOk = false;
    nodes.push({
      repair: t.kind,
      id: t.id,
      name: t.name,
      basis: t.basis,
      from: t.from,
      to: dryRun ? null : t.to,
      id_preserved: after?.id === t.id,
      mastery_state_rows_before: before?.mastery_rows ?? 0,
      mastery_state_rows_after: evidenceAfter.mastery_rows,
      material_fsrs_state_rows_before: before?.fsrs_rows ?? 0,
      material_fsrs_state_rows_after: evidenceAfter.fsrs_rows,
      verified: ok,
    });
  }

  const receipt = {
    operation: 'yuk1604_knowledge_classification_repair',
    actor_ref: ACTOR_REF,
    dry_run: dryRun,
    derived_targets: targets.length,
    role_repairs: targets.filter((t) => t.kind === 'role').length,
    approval_repairs: targets.filter((t) => t.kind === 'approval').length,
    by_basis: Object.fromEntries(
      [...new Set(targets.map((t) => t.basis))].map((basis) => [
        basis,
        targets.filter((t) => t.basis === basis).length,
      ]),
    ),
    verification_ok: verificationOk,
    nodes,
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
