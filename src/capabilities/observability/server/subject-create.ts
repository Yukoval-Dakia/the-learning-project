// 自定义科目创建唯一入口。不 clone trait：六条绑定直指 general 的种子；general 被
// owner 编辑过时绑定的是编辑后的活 trait（DB wins）。
//
// 单事务：控制行 → canonical claim → 六绑定 → ensureSubjectRoot（genesis 与
// anchor 同事务）→ control journal 'create'；提交后全量 re-hydrate，回滚不留
// 内存幻影。
//
// 幂等/撞名：已存在 live custom → 200 回放（重试安全）；custom↔builtin 撞名 →
// 422（否则同名出现两个 id）；并发 23505 → 锁外回读回放，作为双保险。

import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull } from 'drizzle-orm';
import { ensureSubjectRoot, subjectRootId } from '@/capabilities/knowledge/public';
import type { Db, Tx } from '@/db/client';
import {
  subject,
  subject_control_journal,
  subject_name_claim,
  subject_trait_binding,
} from '@/db/schema';
import { hydrateSubjectRegistryFromDb } from '@/kernel/read-models/subject-hydration';
import { isGeneralFallbackFor } from '@/kernel/read-models/subject-trait-resolutions';
import { acquireControlPlaneLockSql } from '@/kernel/records/subject-control-lock';
import { seedTraitId } from '@/subjects/builtin-trait-seeds';
import { normalizeSubjectKey } from '@/subjects/profile';
import { SUBJECT_TRAIT_KINDS } from '@/subjects/trait-schemas';

export interface ThinCreatePayload {
  id: string;
  displayName: string;
  isGeneralFallback: boolean | null;
  revision: number;
  seedRootId: string;
}

export type ThinCreateResult =
  | { kind: 'created'; payload: ThinCreatePayload } // → 201
  | { kind: 'replayed'; payload: ThinCreatePayload } // → 200（幂等回放）
  | { kind: 'invalid'; message: string } // → 400
  | { kind: 'name_conflict'; message: string }; // → 422

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}

async function findLiveCustomByNorm(
  db: Db | Tx,
  norm: string,
): Promise<{ id: string; display_name: string; revision: number } | null> {
  const rows = await db
    .select({
      id: subject.id,
      display_name: subject.display_name,
      revision: subject.revision,
    })
    .from(subject)
    .where(
      and(
        eq(subject.display_name_norm, norm),
        eq(subject.origin, 'custom'),
        isNull(subject.retired_at),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function replayPayload(row: {
  id: string;
  display_name: string;
  revision: number;
}): ThinCreatePayload {
  return {
    id: row.id,
    displayName: row.display_name,
    isGeneralFallback: isGeneralFallbackFor(row.id),
    revision: row.revision,
    seedRootId: subjectRootId(row.id),
  };
}

export async function thinCreateSubject(db: Db, rawDisplayName: string): Promise<ThinCreateResult> {
  const displayName = rawDisplayName.trim();
  const norm = normalizeSubjectKey(displayName);
  if (norm.length === 0) {
    return { kind: 'invalid', message: 'displayName must be non-empty' };
  }

  // 幂等前查只是快路径；权威判定在 tx 内锁下重查，快路径不承载正确性。
  const preExisting = await findLiveCustomByNorm(db, norm);
  if (preExisting) return { kind: 'replayed', payload: replayPayload(preExisting) };

  const id = `subj_${createId()}`;
  const now = new Date();
  try {
    const outcome = await db.transaction(async (tx): Promise<ThinCreateResult | null> => {
      await tx.execute(acquireControlPlaneLockSql);

      // 锁内权威撞名判定：claim 已被非 live custom 占用 → 422 而非回放。
      const claimRows = await tx
        .select({ subject_id: subject_name_claim.subject_id })
        .from(subject_name_claim)
        .where(eq(subject_name_claim.name_norm, norm))
        .limit(1);
      if (claimRows.length > 0) {
        const holder = claimRows[0].subject_id;
        const holderRow = await tx
          .select({ origin: subject.origin, retired_at: subject.retired_at })
          .from(subject)
          .where(eq(subject.id, holder))
          .limit(1);
        const h = holderRow[0];
        if (h && h.origin === 'custom' && h.retired_at === null) {
          const live = await findLiveCustomByNorm(tx, norm);
          if (live) return { kind: 'replayed', payload: replayPayload(live) };
        }
        // builtin 的 canonical/alias（取名 'math'/'wenyan' 之类）、或 retired
        // custom 占坑（restore 撞名语义归 YUK-601 控制行写面）→ 拒。
        return {
          kind: 'name_conflict',
          message: `name '${displayName}' is already claimed by subject '${holder}'`,
        };
      }
      // 显示名撞 live builtin：claim 表 canonical 是 id 命名空间，这里单独兜住
      // 显示名，避免同名双 id。
      const sameName = await tx
        .select({ id: subject.id, origin: subject.origin })
        .from(subject)
        .where(and(eq(subject.display_name_norm, norm), isNull(subject.retired_at)))
        .limit(1);
      if (sameName.length > 0) {
        if (sameName[0].origin === 'custom') {
          const live = await findLiveCustomByNorm(tx, norm);
          if (live) return { kind: 'replayed', payload: replayPayload(live) };
        }
        return {
          kind: 'name_conflict',
          message: `display name '${displayName}' collides with builtin subject '${sameName[0].id}'`,
        };
      }

      await tx.insert(subject).values({
        id,
        display_name: displayName,
        display_name_norm: norm,
        origin: 'custom',
        is_selectable: true,
        retired_at: null,
        revision: 0,
        created_at: now,
        updated_at: now,
      });
      // canonical claim 用 id：claim 表是 id/alias 命名空间，保护 opaque id 不被
      // 他科抢作 alias；显示名唯一性由 custom 部分唯一索引 + 上面的写门承担。
      await tx.insert(subject_name_claim).values({
        name_norm: normalizeSubjectKey(id),
        subject_id: id,
        kind: 'canonical',
        created_at: now,
      });
      // 零复制：六绑定直指 general 种子 trait。
      for (const kind of SUBJECT_TRAIT_KINDS) {
        await tx.insert(subject_trait_binding).values({
          subject_id: id,
          trait_kind: kind,
          trait_id: seedTraitId('general', kind),
        });
      }
      // 建根与 genesis/anchor 同事务，从出生起就是 event-sourced。
      await ensureSubjectRoot(tx, id, displayName);
      // thin-create 是 owner 面，journal actor='owner'。
      await tx.insert(subject_control_journal).values({
        subject_id: id,
        revision: 0,
        action: 'create',
        detail: {},
        actor: 'owner',
        created_at: now,
      });
      return null;
    });
    if (outcome) return outcome;
  } catch (err) {
    // 双保险：并发窗口的 23505（claim PK / norm 部分唯一索引）→ SELECT 回放。
    if (isUniqueViolation(err)) {
      const live = await findLiveCustomByNorm(db, norm);
      if (live) return { kind: 'replayed', payload: replayPayload(live) };
      return {
        kind: 'name_conflict',
        message: `name '${displayName}' is already claimed`,
      };
    }
    throw err;
  }

  // commit 后装配上架（回滚不会走到这里 → 不留内存幻影）。
  await hydrateSubjectRegistryFromDb(db);
  return {
    kind: 'created',
    payload: {
      id,
      displayName,
      isGeneralFallback: isGeneralFallbackFor(id),
      revision: 0,
      seedRootId: subjectRootId(id),
    },
  };
}
