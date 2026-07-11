// YUK-601 (v3.2 §3.1-§3.3 + §3.4 reset-to-seed) — trait 域写面业务层。
// 六个写函数对应六个端点（route 壳在 observability capability）：
//   editSubjectTrait   → PUT  /api/admin/subjects/:id/traits/:kind（主写面，自动 COW）
//   editSharedTrait    → PUT  /api/admin/traits/:traitId（显式共享写）
//   rollbackTrait      → POST /api/admin/traits/:traitId/rollback
//   forkSubjectTrait   → POST /api/admin/subjects/:id/traits/:kind/fork
//   rebindSubjectTrait → PUT  /api/admin/subjects/:id/traits/:kind/binding
//   resetTraitToSeed   → POST /api/admin/traits/:traitId/reset-to-seed
//
// 并发协议（v3.2 owner R2-P1）：一切写事务开头 `pg_advisory_xact_lock`——整面
// 串行化；CAS 语义降级为陈旧 UI 提交守卫（锁内读行比对 expectedRevision，不等
// → 'stale' 携 currentRevision，UPDATE 本身无需 revision 谓词）。
// 所有权判定（v3.2 owner R2-P2，按 trait ownership 不按 subject origin）：
//   自有 ≡ trait.id == trt_seed_<本科>_<kind> 或 owner_subject_id == 本科 → 原地写
//   非自有（他科种子/他科 fork/general 种子）→ 同事务 fork-and-edit（无中间态）
// general 锁定（v3.1 owner P1-1）：fork/换绑对 subject_id='general' 一律 forbidden；
// general 只有自有种子可编（原地写 + fan-out）。
// 每个写函数 commit 后由调用方（route 壳）触发 hydrateSubjectRegistryFromDb——
// 本层保持纯事务语义便于测试直驱。

import { isDeepStrictEqual } from 'node:util';
import { getDefaultRegistry } from '@/core/capability/judges';
import { validateProfile } from '@/core/capability/validate-profile';
import type { Db, Tx } from '@/db/client';
import {
  subject,
  subject_control_journal,
  subject_trait,
  subject_trait_binding,
  subject_trait_journal,
} from '@/db/schema';
import { acquireControlPlaneLockSql } from '@/server/subjects/control-plane-lock';
import {
  BUILTIN_SUBJECT_IDS,
  BUILTIN_TRAIT_SEEDS,
  seedTraitId,
} from '@/subjects/builtin-trait-seeds';
import { assembleSubjectProfile } from '@/subjects/trait-compose';
import {
  SUBJECT_TRAIT_KINDS,
  type SubjectTraitKind,
  type SubjectTraitPayloads,
  TRAIT_PAYLOAD_SCHEMAS,
  TRAIT_PAYLOAD_SCHEMA_VERSIONS,
} from '@/subjects/trait-schemas';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray } from 'drizzle-orm';

// ---------- 结果联合（route 壳映射状态码） ----------

export interface FanoutIssue {
  subjectId: string;
  errors: string[];
}

export type TraitWriteResult =
  | { kind: 'ok'; traitId: string; revision: number; forked: boolean }
  | { kind: 'noop'; traitId: string; revision: number }
  | { kind: 'stale'; currentRevision: number; axis: 'subject' | 'trait' }
  | { kind: 'not_found'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'invalid'; message: string; issues?: FanoutIssue[] };

// ---------- 共享内部件 ----------

function parsePayload(
  kind: SubjectTraitKind,
  payload: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const parsed = TRAIT_PAYLOAD_SCHEMAS[kind].safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, message: `payload failed strict ${kind} schema: ${first}` };
  }
  return { ok: true, value: parsed.data };
}

async function loadSubjectRow(tx: Tx, subjectId: string) {
  const rows = await tx.select().from(subject).where(eq(subject.id, subjectId)).limit(1);
  return rows[0] ?? null;
}

async function loadTraitRow(tx: Tx, traitId: string) {
  const rows = await tx.select().from(subject_trait).where(eq(subject_trait.id, traitId)).limit(1);
  return rows[0] ?? null;
}

/**
 * fan-out 装配校验：对 binders（科目 id 集）逐科装配（`kind` 的 payload 用
 * `overridePayload` 覆盖）+ validateProfile。返回失败清单（空 = 全绿）。
 * version 串用 'preflight'（validateProfile 只要求非空；真组合串是 hydrate 的事）。
 */
async function validateBinders(
  tx: Tx,
  binderIds: string[],
  kind: SubjectTraitKind,
  overridePayload: unknown,
): Promise<FanoutIssue[]> {
  if (binderIds.length === 0) return [];
  const capRegistry = getDefaultRegistry();
  const issues: FanoutIssue[] = [];
  for (const binderId of binderIds) {
    const subjectRows = await tx
      .select({ displayName: subject.display_name })
      .from(subject)
      .where(eq(subject.id, binderId))
      .limit(1);
    const displayName = subjectRows[0]?.displayName ?? binderId;
    const bound = await tx
      .select({
        kind: subject_trait_binding.trait_kind,
        traitId: subject_trait_binding.trait_id,
        payload: subject_trait.payload,
      })
      .from(subject_trait_binding)
      .innerJoin(subject_trait, eq(subject_trait.id, subject_trait_binding.trait_id))
      .where(eq(subject_trait_binding.subject_id, binderId));
    if (bound.length !== SUBJECT_TRAIT_KINDS.length) {
      issues.push({ subjectId: binderId, errors: ['incomplete trait bindings'] });
      continue;
    }
    const payloads = {} as Record<SubjectTraitKind, unknown>;
    for (const b of bound) {
      // 该 kind 一律用候选 payload（编辑=新值 / rollback=目标行 / 换绑=目标 trait /
      // reset-to-seed=代码种子），其余 kind 用当前绑定的活 payload。
      payloads[b.kind] = b.kind === kind ? overridePayload : b.payload;
    }
    try {
      const profile = assembleSubjectProfile({
        id: binderId,
        displayName,
        version: 'preflight',
        payloads: payloads as unknown as SubjectTraitPayloads,
      });
      const result = validateProfile(profile, capRegistry);
      if (!result.valid) issues.push({ subjectId: binderId, errors: result.errors.slice(0, 5) });
    } catch (err) {
      issues.push({
        subjectId: binderId,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
  return issues;
}

async function bindersOf(tx: Tx, traitId: string): Promise<string[]> {
  const rows = await tx
    .select({ subjectId: subject_trait_binding.subject_id })
    .from(subject_trait_binding)
    .where(eq(subject_trait_binding.trait_id, traitId));
  return rows.map((r) => r.subjectId);
}

/** 自有判定（v3.2）：本科种子 或 本科 fork/创建的 custom trait。 */
function ownsTrait(
  subjectId: string,
  trait: { id: string; owner_subject_id: string | null },
  kind: SubjectTraitKind,
): boolean {
  return trait.id === `trt_seed_${subjectId}_${kind}` || trait.owner_subject_id === subjectId;
}

// ---------- 主写面：subject-scoped 编辑（自动 COW） ----------

export async function editSubjectTrait(
  db: Db,
  args: {
    subjectId: string;
    kind: SubjectTraitKind;
    expectedSubjectRevision: number;
    expectedTraitRevision: number;
    payload: unknown;
  },
): Promise<TraitWriteResult> {
  const parsed = parsePayload(args.kind, args.payload);
  if (!parsed.ok) return { kind: 'invalid', message: parsed.message };

  return db.transaction(async (tx): Promise<TraitWriteResult> => {
    await tx.execute(acquireControlPlaneLockSql);
    const now = new Date();

    const subjectRow = await loadSubjectRow(tx, args.subjectId);
    if (!subjectRow) return { kind: 'not_found', message: `unknown subject "${args.subjectId}"` };
    if (subjectRow.revision !== args.expectedSubjectRevision) {
      return { kind: 'stale', currentRevision: subjectRow.revision, axis: 'subject' };
    }

    const bindingRows = await tx
      .select({ traitId: subject_trait_binding.trait_id })
      .from(subject_trait_binding)
      .where(
        and(
          eq(subject_trait_binding.subject_id, args.subjectId),
          eq(subject_trait_binding.trait_kind, args.kind),
        ),
      )
      .limit(1);
    const boundTraitId = bindingRows[0]?.traitId;
    if (!boundTraitId) {
      return {
        kind: 'not_found',
        message: `subject "${args.subjectId}" has no ${args.kind} binding`,
      };
    }
    const trait = await loadTraitRow(tx, boundTraitId);
    if (!trait) return { kind: 'not_found', message: `bound trait "${boundTraitId}" is missing` };
    if (trait.revision !== args.expectedTraitRevision) {
      return { kind: 'stale', currentRevision: trait.revision, axis: 'trait' };
    }

    // deep-equal no-op 预检（v3.2 owner R2-P2）：规范化后深等 → 200，零 fork 零
    // journal 零 bump——「保存未修改的表单」不得制造内容相同的空分叉。
    // 序注（review-765 P3-1）：本实现 CAS 在 no-op 之前——陈旧 revision + 相同
    // payload 返回 409-stale 而非 200-noop（no-op 只对「正编辑当前版本」成立，
    // 陈旧页签先 refetch 再判等更诚实）。§3.1 字面未排 CAS 位置，此为实现裁量。
    if (isDeepStrictEqual(parsed.value, trait.payload)) {
      return { kind: 'noop', traitId: trait.id, revision: trait.revision };
    }

    const own = ownsTrait(args.subjectId, trait, args.kind);

    if (own) {
      // 原地写：自有种子可能被他科借绑 → fan-out 校验波及全部绑定者。
      const binders = await bindersOf(tx, trait.id);
      const issues = await validateBinders(tx, binders, args.kind, parsed.value);
      if (issues.length > 0) {
        return { kind: 'invalid', message: 'assembled profile validation failed', issues };
      }
      const nextRevision = trait.revision + 1;
      await tx
        .update(subject_trait)
        .set({ payload: parsed.value, revision: nextRevision, updated_at: now })
        .where(eq(subject_trait.id, trait.id));
      await tx.insert(subject_trait_journal).values({
        trait_id: trait.id,
        revision: nextRevision,
        payload: parsed.value,
        payload_schema_version: TRAIT_PAYLOAD_SCHEMA_VERSIONS[args.kind],
        seed_version: trait.seed_version,
        action: 'edit',
        actor: 'owner',
        created_at: now,
      });
      return { kind: 'ok', traitId: trait.id, revision: nextRevision, forked: false };
    }

    // 非自有（他科种子/他科 fork/general 种子）→ 同事务 fork-and-edit。
    // general 永不 fork（P1-1）——general 六绑定结构性锁定在自有种子，own 恒真，
    // 走不到这里；防御断言留痕。
    if (args.subjectId === 'general') {
      return { kind: 'forbidden', message: 'general bindings are structurally locked (P1-1)' };
    }
    const newTraitId = `trt_${createId()}`;
    const issues = await validateBinders(tx, [args.subjectId], args.kind, parsed.value);
    if (issues.length > 0) {
      return { kind: 'invalid', message: 'assembled profile validation failed', issues };
    }
    await tx.insert(subject_trait).values({
      id: newTraitId,
      trait_kind: args.kind,
      origin: 'custom',
      payload: parsed.value,
      payload_schema_version: TRAIT_PAYLOAD_SCHEMA_VERSIONS[args.kind],
      seed_version: null,
      owner_subject_id: args.subjectId,
      revision: 1,
      created_at: now,
      updated_at: now,
    });
    // journal rev-0 'fork_source' 携来源快照（provenance 可重建）+ rev-1 'edit' 新 payload。
    await tx.insert(subject_trait_journal).values([
      {
        trait_id: newTraitId,
        revision: 0,
        payload: trait.payload,
        payload_schema_version: trait.payload_schema_version,
        seed_version: null,
        action: 'fork_source',
        actor: 'owner',
        source_trait_id: trait.id,
        source_revision: trait.revision,
        created_at: now,
      },
      {
        trait_id: newTraitId,
        revision: 1,
        payload: parsed.value,
        payload_schema_version: TRAIT_PAYLOAD_SCHEMA_VERSIONS[args.kind],
        seed_version: null,
        action: 'edit',
        actor: 'owner',
        created_at: now,
      },
    ]);
    await tx
      .update(subject_trait_binding)
      .set({ trait_id: newTraitId })
      .where(
        and(
          eq(subject_trait_binding.subject_id, args.subjectId),
          eq(subject_trait_binding.trait_kind, args.kind),
        ),
      );
    const nextSubjectRevision = subjectRow.revision + 1;
    await tx
      .update(subject)
      .set({ revision: nextSubjectRevision, updated_at: now })
      .where(eq(subject.id, args.subjectId));
    await tx.insert(subject_control_journal).values({
      subject_id: args.subjectId,
      revision: nextSubjectRevision,
      action: 'fork',
      detail: { kind: args.kind, from_trait_id: trait.id, to_trait_id: newTraitId },
      actor: 'owner',
      created_at: now,
    });
    return { kind: 'ok', traitId: newTraitId, revision: 1, forked: true };
  });
}

// ---------- 显式共享写：影响全部绑定者 ----------

export async function editSharedTrait(
  db: Db,
  args: { traitId: string; expectedRevision: number; payload: unknown },
): Promise<TraitWriteResult> {
  return db.transaction(async (tx): Promise<TraitWriteResult> => {
    await tx.execute(acquireControlPlaneLockSql);
    const now = new Date();
    const trait = await loadTraitRow(tx, args.traitId);
    if (!trait) return { kind: 'not_found', message: `unknown trait "${args.traitId}"` };
    const parsed = parsePayload(trait.trait_kind, args.payload);
    if (!parsed.ok) return { kind: 'invalid', message: parsed.message };
    if (trait.revision !== args.expectedRevision) {
      return { kind: 'stale', currentRevision: trait.revision, axis: 'trait' };
    }
    if (isDeepStrictEqual(parsed.value, trait.payload)) {
      return { kind: 'noop', traitId: trait.id, revision: trait.revision };
    }
    const binders = await bindersOf(tx, trait.id);
    const issues = await validateBinders(tx, binders, trait.trait_kind, parsed.value);
    if (issues.length > 0) {
      return { kind: 'invalid', message: 'assembled profile validation failed', issues };
    }
    const nextRevision = trait.revision + 1;
    await tx
      .update(subject_trait)
      .set({ payload: parsed.value, revision: nextRevision, updated_at: now })
      .where(eq(subject_trait.id, trait.id));
    await tx.insert(subject_trait_journal).values({
      trait_id: trait.id,
      revision: nextRevision,
      payload: parsed.value,
      payload_schema_version: TRAIT_PAYLOAD_SCHEMA_VERSIONS[trait.trait_kind],
      seed_version: trait.seed_version,
      action: 'edit',
      actor: 'owner',
      created_at: now,
    });
    return { kind: 'ok', traitId: trait.id, revision: nextRevision, forked: false };
  });
}

// ---------- rollback：rollback-forward（git-revert 非 git-reset） ----------

export async function rollbackTrait(
  db: Db,
  args: { traitId: string; expectedRevision: number; targetRevision: number },
): Promise<TraitWriteResult> {
  return db.transaction(async (tx): Promise<TraitWriteResult> => {
    await tx.execute(acquireControlPlaneLockSql);
    const now = new Date();
    const trait = await loadTraitRow(tx, args.traitId);
    if (!trait) return { kind: 'not_found', message: `unknown trait "${args.traitId}"` };
    if (trait.revision !== args.expectedRevision) {
      return { kind: 'stale', currentRevision: trait.revision, axis: 'trait' };
    }
    const targetRows = await tx
      .select()
      .from(subject_trait_journal)
      .where(
        and(
          eq(subject_trait_journal.trait_id, args.traitId),
          eq(subject_trait_journal.revision, args.targetRevision),
        ),
      )
      .limit(1);
    const target = targetRows[0];
    if (!target) {
      return {
        kind: 'invalid',
        message: `target revision ${args.targetRevision} not found in journal`,
      };
    }
    if (isDeepStrictEqual(target.payload, trait.payload)) {
      return { kind: 'noop', traitId: trait.id, revision: trait.revision };
    }
    // §3.1 全套校验（review-765 P2）：先 per-kind strict parse（写入即
    // strict-parseable 不变式——hydrate 的 resolveTraitPayload 用同一 strict
    // schema 读，两头对称，防「fan-out 放行、hydrate 拒收」的静默降级；跨代际
    // upgrade-on-read 是 YUK-599 面的未实现项，目标行拒 parse 即 422 不静默），
    // 再 fan-out 装配（已退场 capability 由 validateProfile 抓 → 422）。
    // 恢复范围 = payload + payload_schema_version（取目标行）；seed lineage 不动
    // （rollback 是内容裁决非血统操作）。
    const reparsed = parsePayload(trait.trait_kind, target.payload);
    if (!reparsed.ok) {
      return {
        kind: 'invalid',
        message: `rollback target no longer parses against the current ${trait.trait_kind} schema: ${reparsed.message}`,
      };
    }
    const binders = await bindersOf(tx, trait.id);
    const issues = await validateBinders(tx, binders, trait.trait_kind, reparsed.value);
    if (issues.length > 0) {
      return { kind: 'invalid', message: 'rollback target fails assembled validation', issues };
    }
    const nextRevision = trait.revision + 1;
    await tx
      .update(subject_trait)
      .set({
        payload: reparsed.value,
        payload_schema_version: target.payload_schema_version,
        revision: nextRevision,
        updated_at: now,
      })
      .where(eq(subject_trait.id, trait.id));
    await tx.insert(subject_trait_journal).values({
      trait_id: trait.id,
      revision: nextRevision,
      payload: reparsed.value,
      payload_schema_version: target.payload_schema_version,
      seed_version: trait.seed_version,
      action: 'rollback',
      actor: 'owner',
      rolled_back_from: args.targetRevision,
      created_at: now,
    });
    return { kind: 'ok', traitId: trait.id, revision: nextRevision, forked: false };
  });
}

// ---------- fork：显式剥离（不带编辑） ----------

export async function forkSubjectTrait(
  db: Db,
  args: { subjectId: string; kind: SubjectTraitKind; expectedSubjectRevision: number },
): Promise<TraitWriteResult> {
  if (args.subjectId === 'general') {
    return { kind: 'forbidden', message: 'general bindings are structurally locked (P1-1)' };
  }
  return db.transaction(async (tx): Promise<TraitWriteResult> => {
    await tx.execute(acquireControlPlaneLockSql);
    const now = new Date();
    const subjectRow = await loadSubjectRow(tx, args.subjectId);
    if (!subjectRow) return { kind: 'not_found', message: `unknown subject "${args.subjectId}"` };
    if (subjectRow.revision !== args.expectedSubjectRevision) {
      return { kind: 'stale', currentRevision: subjectRow.revision, axis: 'subject' };
    }
    const bindingRows = await tx
      .select({ traitId: subject_trait_binding.trait_id })
      .from(subject_trait_binding)
      .where(
        and(
          eq(subject_trait_binding.subject_id, args.subjectId),
          eq(subject_trait_binding.trait_kind, args.kind),
        ),
      )
      .limit(1);
    const boundTraitId = bindingRows[0]?.traitId;
    if (!boundTraitId) {
      return {
        kind: 'not_found',
        message: `subject "${args.subjectId}" has no ${args.kind} binding`,
      };
    }
    const trait = await loadTraitRow(tx, boundTraitId);
    if (!trait) return { kind: 'not_found', message: `bound trait "${boundTraitId}" is missing` };
    if (ownsTrait(args.subjectId, trait, args.kind) && trait.owner_subject_id === args.subjectId) {
      // 已是本科 fork——再剥离无意义（本科种子仍可显式剥离出可编辑副本吗？合同
      // 语义：fork = 「先剥离、稍后再改」的显式意图面，对任何当前绑定 trait 复制；
      // 唯独 general 锁定。本科自有 custom fork 再 fork 只会造孤儿，拒绝。
      return { kind: 'invalid', message: 'binding already points at a subject-owned fork' };
    }
    const newTraitId = `trt_${createId()}`;
    await tx.insert(subject_trait).values({
      id: newTraitId,
      trait_kind: args.kind,
      origin: 'custom',
      payload: trait.payload,
      payload_schema_version: trait.payload_schema_version,
      seed_version: null,
      owner_subject_id: args.subjectId,
      revision: 0,
      created_at: now,
      updated_at: now,
    });
    await tx.insert(subject_trait_journal).values({
      trait_id: newTraitId,
      revision: 0,
      payload: trait.payload,
      payload_schema_version: trait.payload_schema_version,
      seed_version: null,
      action: 'fork_source',
      actor: 'owner',
      source_trait_id: trait.id,
      source_revision: trait.revision,
      created_at: now,
    });
    await tx
      .update(subject_trait_binding)
      .set({ trait_id: newTraitId })
      .where(
        and(
          eq(subject_trait_binding.subject_id, args.subjectId),
          eq(subject_trait_binding.trait_kind, args.kind),
        ),
      );
    const nextSubjectRevision = subjectRow.revision + 1;
    await tx
      .update(subject)
      .set({ revision: nextSubjectRevision, updated_at: now })
      .where(eq(subject.id, args.subjectId));
    await tx.insert(subject_control_journal).values({
      subject_id: args.subjectId,
      revision: nextSubjectRevision,
      action: 'fork',
      detail: { kind: args.kind, from_trait_id: trait.id, to_trait_id: newTraitId },
      actor: 'owner',
      created_at: now,
    });
    return { kind: 'ok', traitId: newTraitId, revision: 0, forked: true };
  });
}

// ---------- 换绑：「化学借数学的 rubric」载体 ----------

export async function rebindSubjectTrait(
  db: Db,
  args: {
    subjectId: string;
    kind: SubjectTraitKind;
    targetTraitId: string;
    expectedSubjectRevision: number;
  },
): Promise<TraitWriteResult> {
  if (args.subjectId === 'general') {
    return { kind: 'forbidden', message: 'general bindings are structurally locked (P1-1)' };
  }
  return db.transaction(async (tx): Promise<TraitWriteResult> => {
    await tx.execute(acquireControlPlaneLockSql);
    const now = new Date();
    const subjectRow = await loadSubjectRow(tx, args.subjectId);
    if (!subjectRow) return { kind: 'not_found', message: `unknown subject "${args.subjectId}"` };
    if (subjectRow.revision !== args.expectedSubjectRevision) {
      return { kind: 'stale', currentRevision: subjectRow.revision, axis: 'subject' };
    }
    const target = await loadTraitRow(tx, args.targetTraitId);
    if (!target) return { kind: 'not_found', message: `unknown trait "${args.targetTraitId}"` };
    if (target.trait_kind !== args.kind) {
      return {
        kind: 'invalid',
        message: `target trait is ${target.trait_kind}, expected ${args.kind}`,
      };
    }
    const bindingRows = await tx
      .select({ traitId: subject_trait_binding.trait_id })
      .from(subject_trait_binding)
      .where(
        and(
          eq(subject_trait_binding.subject_id, args.subjectId),
          eq(subject_trait_binding.trait_kind, args.kind),
        ),
      )
      .limit(1);
    const fromTraitId = bindingRows[0]?.traitId;
    if (!fromTraitId) {
      return {
        kind: 'not_found',
        message: `subject "${args.subjectId}" has no ${args.kind} binding`,
      };
    }
    if (fromTraitId === args.targetTraitId) {
      return { kind: 'noop', traitId: fromTraitId, revision: target.revision };
    }
    // 装配校验本科（新绑定生效后的六件套）。
    const issues = await validateBinders(tx, [args.subjectId], args.kind, target.payload);
    if (issues.length > 0) {
      return { kind: 'invalid', message: 'rebound profile fails assembled validation', issues };
    }
    await tx
      .update(subject_trait_binding)
      .set({ trait_id: args.targetTraitId })
      .where(
        and(
          eq(subject_trait_binding.subject_id, args.subjectId),
          eq(subject_trait_binding.trait_kind, args.kind),
        ),
      );
    const nextSubjectRevision = subjectRow.revision + 1;
    await tx
      .update(subject)
      .set({ revision: nextSubjectRevision, updated_at: now })
      .where(eq(subject.id, args.subjectId));
    await tx.insert(subject_control_journal).values({
      subject_id: args.subjectId,
      revision: nextSubjectRevision,
      action: 'rebind',
      detail: { kind: args.kind, from_trait_id: fromTraitId, to_trait_id: args.targetTraitId },
      actor: 'owner',
      created_at: now,
    });
    return { kind: 'ok', traitId: args.targetTraitId, revision: target.revision, forked: false };
  });
}

// ---------- reset-to-seed：恢复出厂内容（trait 级，全局显式动作） ----------

export async function resetTraitToSeed(
  db: Db,
  args: { traitId: string; expectedRevision: number },
): Promise<TraitWriteResult> {
  return db.transaction(async (tx): Promise<TraitWriteResult> => {
    await tx.execute(acquireControlPlaneLockSql);
    const now = new Date();
    const trait = await loadTraitRow(tx, args.traitId);
    if (!trait) return { kind: 'not_found', message: `unknown trait "${args.traitId}"` };
    if (trait.seed_version === null) {
      return { kind: 'invalid', message: 'reset-to-seed is only legal for seed-lineage traits' };
    }
    if (trait.revision !== args.expectedRevision) {
      return { kind: 'stale', currentRevision: trait.revision, axis: 'trait' };
    }
    const seedSubject = BUILTIN_SUBJECT_IDS.find(
      (s) => seedTraitId(s, trait.trait_kind) === trait.id,
    );
    if (!seedSubject) {
      return { kind: 'invalid', message: 'trait has seed_version but no matching code seed' };
    }
    const seed = BUILTIN_TRAIT_SEEDS[seedSubject][trait.trait_kind];
    if (isDeepStrictEqual(seed.payload, trait.payload) && trait.seed_version === seed.seedVersion) {
      return { kind: 'noop', traitId: trait.id, revision: trait.revision };
    }
    const binders = await bindersOf(tx, trait.id);
    const issues = await validateBinders(tx, binders, trait.trait_kind, seed.payload);
    if (issues.length > 0) {
      return { kind: 'invalid', message: 'seed payload fails assembled validation', issues };
    }
    const nextRevision = trait.revision + 1;
    await tx
      .update(subject_trait)
      .set({
        payload: seed.payload,
        payload_schema_version: seed.payloadSchemaVersion,
        seed_version: seed.seedVersion,
        revision: nextRevision,
        updated_at: now,
      })
      .where(eq(subject_trait.id, trait.id));
    await tx.insert(subject_trait_journal).values({
      trait_id: trait.id,
      revision: nextRevision,
      payload: seed.payload,
      payload_schema_version: seed.payloadSchemaVersion,
      seed_version: seed.seedVersion,
      action: 'reset_to_seed',
      actor: 'owner',
      created_at: now,
    });
    return { kind: 'ok', traitId: trait.id, revision: nextRevision, forked: false };
  });
}
