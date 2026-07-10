// YUK-599 (YUK-597 v3 trait 合同 §6) — reconcileBuiltinTraits：migrate init
// container 专属的种子/升级单写者（app/worker boot 只 read-hydrate，避免竞写）。
//
// per-trait 纪律（§6）：
// - **触发信号 = 代码种子 semver ≠ 行 seed_version**；相等 → 整行硬跳过（不碰
//   payload/updated_at/revision/journal——「重跑零副作用」由条件写成立，不是裸
//   ON CONFLICT DO UPDATE 能给的）。
// - 行不存在 → INSERT + journal rev-0（action='create'，actor='migrate'）。
//   通则：一切 trait 创建路径必须写 rev-0 journal 行。
// - 不等且未被 owner 编辑 → 覆盖升级 + seed_version 对齐 + journal 'reconcile'；
//   被编辑过 → 保留 + WARN。
// - **「被 owner 编辑」= journal 谓词**（不设列、不用 created_at）：∃ actor='owner'
//   行，其 revision > max(revision WHERE action ∈ {create, reconcile,
//   reset_to_seed})——reset-to-seed 后谓词翻回未编辑，种子升级恢复送达（append-only
//   下「永久冻结」的解法；reset_to_seed 自身虽是 owner 行但同时就是新边界，严格
//   大于号天然自排除）。
// - **并发纪律（v3.2）**：事务开头取控制面 advisory lock，owner-journal 判定在
//   锁内读——不与并发的 owner 写互踩。
//
// 绑定 ×24 / subject 行 ×4 / claims 全部 insert-if-missing：owner 的换绑/rename
// 不被 migrate 重跑覆写（reconcile 只治理 trait 内容血统，不治理控制行）。

import type { Db } from '@/db/client';
import {
  subject,
  subject_control_journal,
  subject_name_claim,
  subject_trait,
  subject_trait_binding,
  subject_trait_journal,
} from '@/db/schema';
import {
  BUILTIN_SUBJECT_IDS,
  BUILTIN_TRAIT_SEEDS,
  type BuiltinSubjectId,
  seedTraitId,
} from '@/subjects/builtin-trait-seeds';
import { BUILTIN_SUBJECT_ALIASES, normalizeSubjectKey, subjectProfiles } from '@/subjects/profile';
import { SUBJECT_TRAIT_KINDS, type SubjectTraitKind } from '@/subjects/trait-schemas';
import { and, eq, inArray } from 'drizzle-orm';
import { acquireControlPlaneLockSql } from './control-plane-lock';

// drizzle 事务句柄类型（tx 不带 $client，不能用裸 Db）。
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface BuiltinTraitReconcileReport {
  insertedTraits: number;
  upgradedTraits: number;
  skippedTraits: number; // seed_version 相等的硬跳过
  preservedTraits: number; // owner 编辑过、保留 + WARN
  insertedSubjects: number;
}

async function isOwnerEdited(tx: Tx, traitId: string): Promise<boolean> {
  const rows = await tx
    .select({
      revision: subject_trait_journal.revision,
      action: subject_trait_journal.action,
      actor: subject_trait_journal.actor,
    })
    .from(subject_trait_journal)
    .where(eq(subject_trait_journal.trait_id, traitId));
  let boundary = -1;
  for (const r of rows) {
    if (
      (r.action === 'create' || r.action === 'reconcile' || r.action === 'reset_to_seed') &&
      r.revision > boundary
    ) {
      boundary = r.revision;
    }
  }
  return rows.some((r) => r.actor === 'owner' && r.revision > boundary);
}

export async function reconcileBuiltinTraits(db: Db): Promise<BuiltinTraitReconcileReport> {
  const report: BuiltinTraitReconcileReport = {
    insertedTraits: 0,
    upgradedTraits: 0,
    skippedTraits: 0,
    preservedTraits: 0,
    insertedSubjects: 0,
  };
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.execute(acquireControlPlaneLockSql);

    for (const subjectId of BUILTIN_SUBJECT_IDS) {
      const profile = subjectProfiles[subjectId];
      if (!profile) throw new Error(`reconcileBuiltinTraits: builtin '${subjectId}' missing`);

      // ① subject 控制行：insert-if-missing（rename/retire 是 owner 面，不覆写）。
      const insertedSubject = await tx
        .insert(subject)
        .values({
          id: subjectId,
          display_name: profile.displayName,
          display_name_norm: normalizeSubjectKey(profile.displayName),
          origin: 'builtin',
          is_selectable: subjectId !== 'general', // general 结构性排除（v2 §2.1）
          retired_at: null,
          revision: 0,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing({ target: subject.id })
        .returning({ id: subject.id });
      if (insertedSubject.length > 0) {
        report.insertedSubjects += 1;
        // control journal 'create' 行（rev 0，actor='migrate'）——只随真插入落。
        await tx
          .insert(subject_control_journal)
          .values({
            subject_id: subjectId,
            revision: 0,
            action: 'create',
            detail: {},
            actor: 'migrate',
            created_at: now,
          })
          .onConflictDoNothing();
      }

      // ② claims：canonical + builtin 别名（insert-if-missing；PK 拦抢占）。
      await tx
        .insert(subject_name_claim)
        .values({
          name_norm: normalizeSubjectKey(subjectId),
          subject_id: subjectId,
          kind: 'canonical',
          created_at: now,
        })
        .onConflictDoNothing();
      for (const alias of BUILTIN_SUBJECT_ALIASES[subjectId] ?? []) {
        await tx
          .insert(subject_name_claim)
          .values({
            name_norm: normalizeSubjectKey(alias),
            subject_id: subjectId,
            kind: 'alias',
            created_at: now,
          })
          .onConflictDoNothing();
      }

      // ③ per-trait 种子/升级。
      for (const kind of SUBJECT_TRAIT_KINDS) {
        const seed = BUILTIN_TRAIT_SEEDS[subjectId as BuiltinSubjectId][kind];
        const traitId = seedTraitId(subjectId as BuiltinSubjectId, kind);
        const [row] = await tx
          .select({
            id: subject_trait.id,
            seed_version: subject_trait.seed_version,
            revision: subject_trait.revision,
          })
          .from(subject_trait)
          .where(eq(subject_trait.id, traitId));

        if (!row) {
          await tx.insert(subject_trait).values({
            id: traitId,
            trait_kind: kind,
            origin: 'builtin',
            payload: seed.payload,
            payload_schema_version: seed.payloadSchemaVersion,
            seed_version: seed.seedVersion,
            owner_subject_id: null, // 种子恒 null：属主由 id 模式表达
            revision: 0,
            created_at: now,
            updated_at: now,
          });
          await tx.insert(subject_trait_journal).values({
            trait_id: traitId,
            revision: 0,
            payload: seed.payload,
            payload_schema_version: seed.payloadSchemaVersion,
            seed_version: seed.seedVersion,
            action: 'create',
            actor: 'migrate',
            created_at: now,
          });
          report.insertedTraits += 1;
        } else if (row.seed_version === seed.seedVersion) {
          report.skippedTraits += 1; // 硬 no-op：零写（幂等的机械基础）
        } else if (await isOwnerEdited(tx, traitId)) {
          console.warn(
            '[migrate] builtin trait seed upgrade withheld — owner-edited (reset-to-seed 可恢复送达)',
            { traitId, rowSeed: row.seed_version, codeSeed: seed.seedVersion },
          );
          report.preservedTraits += 1;
        } else {
          const nextRevision = row.revision + 1;
          await tx
            .update(subject_trait)
            .set({
              payload: seed.payload,
              payload_schema_version: seed.payloadSchemaVersion,
              seed_version: seed.seedVersion,
              revision: nextRevision,
              updated_at: now,
            })
            .where(and(eq(subject_trait.id, traitId), eq(subject_trait.revision, row.revision)));
          await tx.insert(subject_trait_journal).values({
            trait_id: traitId,
            revision: nextRevision,
            payload: seed.payload,
            payload_schema_version: seed.payloadSchemaVersion,
            seed_version: seed.seedVersion,
            action: 'reconcile',
            actor: 'migrate',
            created_at: now,
          });
          report.upgradedTraits += 1;
        }
      }

      // ④ 绑定 ×6：insert-if-missing（owner 换绑不被重跑覆写）。
      for (const kind of SUBJECT_TRAIT_KINDS) {
        await tx
          .insert(subject_trait_binding)
          .values({
            subject_id: subjectId,
            trait_kind: kind,
            trait_id: seedTraitId(subjectId as BuiltinSubjectId, kind),
          })
          .onConflictDoNothing();
      }
    }
  });

  return report;
}
