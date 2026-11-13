// 内置科目经验文档的 migrate-init 单写者；app/worker boot 只读，避免竞写。
// 与 reconcileBuiltinTraits 同一纪律：事务经 withControlPlane 先取控制面锁。
//
// 幂等键 = 正文内容哈希作 seed_version：相等硬跳过（不碰行/journal），不等时
// 未被 owner 编辑 → revision+1 覆盖 + 'reconcile'；编辑过 → 保留 + WARN。
// 「被 owner 编辑」的判定与 trait journal 同边界（actor='owner' 且 revision
// 越过最近 create/reconcile/reset_to_seed）。

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { subject_doc, subject_doc_journal } from '@/db/schema';
import {
  BUILTIN_DOC_SEEDS,
  builtinDocSeedDetail,
  resolveBuiltinDocBody,
} from '@/subjects/builtin-doc-seeds';
import { BUILTIN_SUBJECT_IDS, type BuiltinSubjectId } from '@/subjects/builtin-trait-seeds';
import { subjectProfiles } from '@/subjects/profile';
import { withControlPlane } from './subject-control/commit';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface BuiltinDocReconcileReport {
  insertedDocs: number;
  upgradedDocs: number;
  skippedDocs: number;
  preservedDocs: number;
}

async function isOwnerEdited(tx: Tx, subjectId: string, docKey: string): Promise<boolean> {
  const rows = await tx
    .select({
      revision: subject_doc_journal.revision,
      action: subject_doc_journal.action,
      actor: subject_doc_journal.actor,
    })
    .from(subject_doc_journal)
    .where(
      and(eq(subject_doc_journal.subject_id, subjectId), eq(subject_doc_journal.doc_key, docKey)),
    );
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

function docSeedVersion(body: string): string {
  return `sha256:${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
}

export async function reconcileBuiltinSubjectDocs(
  db: Db,
  subjectsRoot?: string,
): Promise<BuiltinDocReconcileReport> {
  const report: BuiltinDocReconcileReport = {
    insertedDocs: 0,
    upgradedDocs: 0,
    skippedDocs: 0,
    preservedDocs: 0,
  };
  const now = new Date();

  await withControlPlane(db, async (tx) => {
    for (const subjectId of BUILTIN_SUBJECT_IDS) {
      const profile = subjectProfiles[subjectId as BuiltinSubjectId];
      if (!profile) throw new Error(`reconcileBuiltinSubjectDocs: builtin '${subjectId}' missing`);

      for (const seed of BUILTIN_DOC_SEEDS[subjectId as BuiltinSubjectId]) {
        const body = await resolveBuiltinDocBody(seed, profile, subjectsRoot);
        const seedVersion = docSeedVersion(body);
        const detail = builtinDocSeedDetail(seed);

        const [row] = await tx
          .select({
            seed_version: subject_doc.seed_version,
            revision: subject_doc.revision,
          })
          .from(subject_doc)
          .where(and(eq(subject_doc.subject_id, subjectId), eq(subject_doc.doc_key, seed.docKey)));

        if (!row) {
          await tx.insert(subject_doc).values({
            subject_id: subjectId,
            doc_key: seed.docKey,
            title: seed.title,
            summary: seed.summary,
            body,
            origin: 'builtin',
            seed_version: seedVersion,
            revision: 0,
            created_at: now,
            updated_at: now,
          });
          await tx.insert(subject_doc_journal).values({
            subject_id: subjectId,
            doc_key: seed.docKey,
            revision: 0,
            title: seed.title,
            summary: seed.summary,
            body,
            seed_version: seedVersion,
            action: 'create',
            actor: 'migrate',
            detail,
            created_at: now,
          });
          report.insertedDocs += 1;
        } else if (row.seed_version === seedVersion) {
          report.skippedDocs += 1;
        } else if (await isOwnerEdited(tx, subjectId, seed.docKey)) {
          console.warn(
            '[migrate] builtin doc seed upgrade withheld — owner-edited (reset-to-seed 可恢复送达)',
            { subjectId, docKey: seed.docKey, rowSeed: row.seed_version, codeSeed: seedVersion },
          );
          report.preservedDocs += 1;
        } else {
          const nextRevision = row.revision + 1;
          await tx
            .update(subject_doc)
            .set({
              title: seed.title,
              summary: seed.summary,
              body,
              seed_version: seedVersion,
              revision: nextRevision,
              updated_at: now,
            })
            .where(
              and(
                eq(subject_doc.subject_id, subjectId),
                eq(subject_doc.doc_key, seed.docKey),
                eq(subject_doc.revision, row.revision),
              ),
            );
          await tx.insert(subject_doc_journal).values({
            subject_id: subjectId,
            doc_key: seed.docKey,
            revision: nextRevision,
            title: seed.title,
            summary: seed.summary,
            body,
            seed_version: seedVersion,
            action: 'reconcile',
            actor: 'migrate',
            detail,
            created_at: now,
          });
          report.upgradedDocs += 1;
        }
      }
    }
  });

  return report;
}
