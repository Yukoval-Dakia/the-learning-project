// YUK-601 (v3.2 §3.4) — 控制行写面业务层（CAS 轴 = subject.revision）：
//   renameSubject   → PATCH /api/admin/subjects/:id            {expectedRevision, displayName}
//   retireSubject   → POST  /api/admin/subjects/:id/retire     {expectedRevision}
//   restoreSubject  → POST  /api/admin/subjects/:id/restore    {expectedRevision}
//   resetSubject    → POST  /api/admin/subjects/:id/reset      {expectedRevision}
//   validateSubject → POST  /api/admin/subjects/:id/validate   {traitPayloadOverrides}（无状态）
//
// 与 trait-write 同一并发协议：写事务开头控制面 advisory lock；CAS = 陈旧 UI
// 提交守卫（锁内比对，'stale' 携 currentRevision）。
// rename/reset 的 root.name 同步写专属 fold event；row + event 同事务、同时间戳，projection
// rebuild 不再把控制面名称洗回 genesis 旧值（YUK-728）。

import { isDeepStrictEqual } from 'node:util';
import { getDefaultRegistry } from '@/core/capability/judges';
import { validateProfile } from '@/core/capability/validate-profile';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import {
  knowledge,
  subject,
  subject_control_journal,
  subject_trait,
  subject_trait_binding,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { acquireControlPlaneLockSql } from '@/server/subjects/control-plane-lock';
import { subjectRootId } from '@/server/subjects/ensure-subject-root';
import {
  BUILTIN_SUBJECT_IDS,
  type BuiltinSubjectId,
  seedTraitId,
} from '@/subjects/builtin-trait-seeds';
import { normalizeSubjectKey, subjectProfiles } from '@/subjects/profile';
import { assembleSubjectProfile } from '@/subjects/trait-compose';
import {
  SUBJECT_TRAIT_KINDS,
  type SubjectTraitKind,
  type SubjectTraitPayloads,
} from '@/subjects/trait-schemas';
import { and, eq, isNull, ne } from 'drizzle-orm';

export type ControlWriteResult =
  | { kind: 'ok'; subjectRevision: number }
  | { kind: 'noop'; subjectRevision: number }
  | { kind: 'stale'; currentRevision: number }
  | { kind: 'not_found'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'invalid'; message: string };

async function loadSubjectRow(tx: Tx, subjectId: string) {
  const rows = await tx.select().from(subject).where(eq(subject.id, subjectId)).limit(1);
  return rows[0] ?? null;
}

/** 撞名检查（rename/restore 共用）：任何**其它** live 行占用同 norm → conflict。 */
async function normCollides(tx: Tx, subjectId: string, norm: string): Promise<boolean> {
  const rows = await tx
    .select({ id: subject.id })
    .from(subject)
    .where(
      and(
        eq(subject.display_name_norm, norm),
        ne(subject.id, subjectId),
        isNull(subject.retired_at),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function updateSubjectRootName(
  tx: Tx,
  args: {
    subjectId: string;
    nextName: string;
    controlAction: 'rename' | 'reset';
  },
): Promise<void> {
  const rootId = subjectRootId(args.subjectId);
  const [root] = await tx
    .select({ name: knowledge.name, version: knowledge.version })
    .from(knowledge)
    .where(eq(knowledge.id, rootId))
    .limit(1)
    .for('update');
  // Legacy/test control rows can exist without a root. There is no knowledge row mutation in that
  // case, so no fold event is needed; a later ensureSubjectRoot writes a genesis with displayName.
  if (!root) return;

  // Stamp the materialization only after the root row lock is acquired. A knowledge
  // proposal can mutate this root without taking the subject control-plane lock; reusing
  // the caller's earlier transaction timestamp would let replay order this rename before
  // the mutation whose post-version we just observed.
  const materializedAt = new Date();
  const nextVersion = root.version + 1;
  const updated = await tx
    .update(knowledge)
    .set({ name: args.nextName, updated_at: materializedAt, version: nextVersion })
    .where(and(eq(knowledge.id, rootId), eq(knowledge.version, root.version)))
    .returning({ id: knowledge.id });
  if (updated.length === 0) {
    throw new Error(`subject root ${rootId} changed while applying ${args.controlAction}`);
  }

  await writeEvent(tx, {
    id: newId(),
    actor_kind: 'user',
    actor_ref: 'owner',
    action: 'experimental:subject_root_name_update',
    subject_kind: 'knowledge',
    subject_id: rootId,
    outcome: 'success',
    payload: {
      control_action: args.controlAction,
      subject_id: args.subjectId,
      previous_name: root.name,
      next_name: args.nextName,
      previous_version: root.version,
      next_version: nextVersion,
    },
    created_at: materializedAt,
    // Control-plane structure, not learner evidence: keep it out of the Mem0/brief outbox.
    ingest_at: materializedAt,
  });
}

// ---------- rename ----------

export async function renameSubject(
  db: Db,
  args: { subjectId: string; expectedRevision: number; displayName: string },
): Promise<ControlWriteResult> {
  const displayName = args.displayName.trim();
  if (displayName.length === 0)
    return { kind: 'invalid', message: 'displayName must be non-empty' };
  const norm = normalizeSubjectKey(displayName);

  return db.transaction(async (tx): Promise<ControlWriteResult> => {
    await tx.execute(acquireControlPlaneLockSql);
    const now = new Date();
    const row = await loadSubjectRow(tx, args.subjectId);
    if (!row) return { kind: 'not_found', message: `unknown subject "${args.subjectId}"` };
    if (row.revision !== args.expectedRevision) {
      return { kind: 'stale', currentRevision: row.revision };
    }
    if (row.display_name === displayName) return { kind: 'noop', subjectRevision: row.revision };
    if (await normCollides(tx, args.subjectId, norm)) {
      return { kind: 'conflict', message: `display name "${displayName}" is already taken` };
    }
    const nextRevision = row.revision + 1;
    await tx
      .update(subject)
      .set({
        display_name: displayName,
        display_name_norm: norm,
        revision: nextRevision,
        updated_at: now,
      })
      .where(eq(subject.id, args.subjectId));
    await updateSubjectRootName(tx, {
      subjectId: args.subjectId,
      nextName: displayName,
      controlAction: 'rename',
    });
    await tx.insert(subject_control_journal).values({
      subject_id: args.subjectId,
      revision: nextRevision,
      action: 'rename',
      detail: { from: row.display_name, to: displayName },
      actor: 'owner',
      created_at: now,
    });
    return { kind: 'ok', subjectRevision: nextRevision };
  });
}

// ---------- retire / restore ----------

export async function retireSubject(
  db: Db,
  args: { subjectId: string; expectedRevision: number },
): Promise<ControlWriteResult> {
  if (args.subjectId === 'general') {
    // 固定 default fallback；可替换 fallback 机制不采纳（v3.2 §3.4）。
    return { kind: 'forbidden', message: 'general cannot be retired' };
  }
  return db.transaction(async (tx): Promise<ControlWriteResult> => {
    await tx.execute(acquireControlPlaneLockSql);
    const now = new Date();
    const row = await loadSubjectRow(tx, args.subjectId);
    if (!row) return { kind: 'not_found', message: `unknown subject "${args.subjectId}"` };
    if (row.revision !== args.expectedRevision) {
      return { kind: 'stale', currentRevision: row.revision };
    }
    if (row.retired_at !== null) return { kind: 'noop', subjectRevision: row.revision };
    const nextRevision = row.revision + 1;
    await tx
      .update(subject)
      .set({ retired_at: now, revision: nextRevision, updated_at: now })
      .where(eq(subject.id, args.subjectId));
    await tx.insert(subject_control_journal).values({
      subject_id: args.subjectId,
      revision: nextRevision,
      action: 'retire',
      detail: {},
      actor: 'owner',
      created_at: now,
    });
    return { kind: 'ok', subjectRevision: nextRevision };
  });
}

export async function restoreSubject(
  db: Db,
  args: { subjectId: string; expectedRevision: number },
): Promise<ControlWriteResult> {
  return db.transaction(async (tx): Promise<ControlWriteResult> => {
    await tx.execute(acquireControlPlaneLockSql);
    const now = new Date();
    const row = await loadSubjectRow(tx, args.subjectId);
    if (!row) return { kind: 'not_found', message: `unknown subject "${args.subjectId}"` };
    if (row.revision !== args.expectedRevision) {
      return { kind: 'stale', currentRevision: row.revision };
    }
    if (row.retired_at === null) return { kind: 'noop', subjectRevision: row.revision };
    // restore 撞名 409：退休期间同名可能被新科占用。
    if (await normCollides(tx, args.subjectId, row.display_name_norm)) {
      return {
        kind: 'conflict',
        message: `display name "${row.display_name}" is now taken by another live subject`,
      };
    }
    const nextRevision = row.revision + 1;
    await tx
      .update(subject)
      .set({ retired_at: null, revision: nextRevision, updated_at: now })
      .where(eq(subject.id, args.subjectId));
    await tx.insert(subject_control_journal).values({
      subject_id: args.subjectId,
      revision: nextRevision,
      action: 'restore',
      detail: {},
      actor: 'owner',
      created_at: now,
    });
    return { kind: 'ok', subjectRevision: nextRevision };
  });
}

// ---------- reset（subject 级）：只换绑，永不改共享 payload ----------

export async function resetSubject(
  db: Db,
  args: { subjectId: string; expectedRevision: number },
): Promise<ControlWriteResult> {
  if (args.subjectId === 'general') {
    // general 绑定结构性锁定在自有种子（P1-1）——reset 无意义且换绑面被锁。
    return { kind: 'forbidden', message: 'general bindings are structurally locked (P1-1)' };
  }
  return db.transaction(async (tx): Promise<ControlWriteResult> => {
    await tx.execute(acquireControlPlaneLockSql);
    const now = new Date();
    const row = await loadSubjectRow(tx, args.subjectId);
    if (!row) return { kind: 'not_found', message: `unknown subject "${args.subjectId}"` };
    if (row.revision !== args.expectedRevision) {
      return { kind: 'stale', currentRevision: row.revision };
    }

    const isBuiltin = row.origin === 'builtin';
    // custom → general 种子；builtin → 本科种子（v3.2 §3.4）。
    const seedSubject = (isBuiltin ? args.subjectId : 'general') as BuiltinSubjectId;
    if (isBuiltin && !(BUILTIN_SUBJECT_IDS as readonly string[]).includes(args.subjectId)) {
      return { kind: 'invalid', message: `builtin subject "${args.subjectId}" has no code seeds` };
    }

    const bindings = await tx
      .select({
        kind: subject_trait_binding.trait_kind,
        traitId: subject_trait_binding.trait_id,
      })
      .from(subject_trait_binding)
      .where(eq(subject_trait_binding.subject_id, args.subjectId));
    const byKind = new Map(bindings.map((b) => [b.kind, b.traitId]));

    const rebound: Array<{ kind: SubjectTraitKind; from_trait_id: string; to_trait_id: string }> =
      [];
    for (const kind of SUBJECT_TRAIT_KINDS) {
      const from = byKind.get(kind);
      const to = seedTraitId(seedSubject, kind);
      if (from && from !== to) rebound.push({ kind, from_trait_id: from, to_trait_id: to });
    }

    // displayName 联动：custom 保留；builtin 回种子名 + root.name 同步（镜像
    // rename 的写点纪律，v3.2 §3.4）。
    const seedDisplayName = isBuiltin
      ? (subjectProfiles[args.subjectId]?.displayName ?? row.display_name)
      : row.display_name;
    const nameChanges = seedDisplayName !== row.display_name;

    if (rebound.length === 0 && !nameChanges) {
      return { kind: 'noop', subjectRevision: row.revision };
    }

    for (const r of rebound) {
      await tx
        .update(subject_trait_binding)
        .set({ trait_id: r.to_trait_id })
        .where(
          and(
            eq(subject_trait_binding.subject_id, args.subjectId),
            eq(subject_trait_binding.trait_kind, r.kind),
          ),
        );
    }
    const nextRevision = row.revision + 1;
    await tx
      .update(subject)
      .set({
        revision: nextRevision,
        updated_at: now,
        ...(nameChanges
          ? {
              display_name: seedDisplayName,
              display_name_norm: normalizeSubjectKey(seedDisplayName),
            }
          : {}),
      })
      .where(eq(subject.id, args.subjectId));
    if (nameChanges) {
      await updateSubjectRootName(tx, {
        subjectId: args.subjectId,
        nextName: seedDisplayName,
        controlAction: 'reset',
      });
    }
    await tx.insert(subject_control_journal).values({
      subject_id: args.subjectId,
      revision: nextRevision,
      action: 'reset',
      detail: { rebound },
      actor: 'owner',
      created_at: now,
    });
    // 孤儿化 fork trait 及其 journal 保留（无硬删面）。
    return { kind: 'ok', subjectRevision: nextRevision };
  });
}

// ---------- validate（无状态预检） ----------

export interface ValidateSubjectResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** null = subject 不存在。零落库、零 CAS（只读，无需锁）。 */
export async function validateSubject(
  db: Db,
  subjectId: string,
  traitPayloadOverrides?: Partial<Record<SubjectTraitKind, unknown>>,
): Promise<ValidateSubjectResult | null> {
  const rows = await db
    .select({ displayName: subject.display_name })
    .from(subject)
    .where(eq(subject.id, subjectId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const bound = await db
    .select({
      kind: subject_trait_binding.trait_kind,
      payload: subject_trait.payload,
    })
    .from(subject_trait_binding)
    .innerJoin(subject_trait, eq(subject_trait.id, subject_trait_binding.trait_id))
    .where(eq(subject_trait_binding.subject_id, subjectId));
  if (bound.length !== SUBJECT_TRAIT_KINDS.length) {
    return { valid: false, errors: ['incomplete trait bindings'], warnings: [] };
  }
  const payloads = {} as Record<SubjectTraitKind, unknown>;
  for (const b of bound) {
    payloads[b.kind] = traitPayloadOverrides?.[b.kind] ?? b.payload;
  }
  try {
    const profile = assembleSubjectProfile({
      id: subjectId,
      displayName: row.displayName,
      version: 'preflight',
      payloads: payloads as unknown as SubjectTraitPayloads,
    });
    const result = validateProfile(profile, getDefaultRegistry());
    return { valid: result.valid, errors: result.errors, warnings: result.warnings };
  } catch (err) {
    return {
      valid: false,
      errors: [err instanceof Error ? err.message : String(err)],
      warnings: [],
    };
  }
}
