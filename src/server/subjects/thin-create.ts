// YUK-600 (YUK-597 v3 §3.6) — thin-create：科目创建唯一入口（比 v2 更薄——
// **零 clone、零新 trait 行**：六条绑定直指 general 的种子 trait；general 若已被
// owner 编辑过，绑定的就是编辑后的活 trait——v3 §2.3「DB wins」直译）。
//
// 单事务五步（事务开头取控制面 advisory lock，v3 §3.1 并发协议）：
//   ① INSERT subject 控制行（origin='custom'，服务端 mint `subj_<cuid2>`）
//   ② INSERT canonical claim（name_norm 单命名空间，PK 拦全部抢占）
//   ③ 六绑定 → trt_seed_general_<kind>（零复制）
//   ④ ensureSubjectRoot（root 钉 `seed:<id>:root` + genesis + anchor，
//      event-sourced from birth）
//   ⑤ subject_control_journal 'create' 行（revision 0，actor='owner'）
// → commit 后 registry 装配上架（全量 re-hydrate：level-triggered、回滚不留
//   内存幻影；~10 科规模毫秒级）。
//
// 幂等/撞名（v2 §3.2 原样承接）：
//   - 命中已存在 live custom（display_name_norm 部分唯一索引语义）→ **200 回放**
//     非 422（网络重试安全，UI 零去重逻辑）；
//   - custom↔builtin 撞名（norm 撞 builtin 的 canonical/alias claim）→ **422**
//     （否则 knownSubjects 分类词表出现同名双 id）；
//   - 并发 23505 → SELECT 回放（advisory lock 已串行化，这是双保险）；
//   - 永不产生第二行/第二根/第二 claim。

import type { Db } from '@/db/client';
import {
  subject,
  subject_control_journal,
  subject_name_claim,
  subject_trait_binding,
} from '@/db/schema';
import { seedTraitId } from '@/subjects/builtin-trait-seeds';
import { normalizeSubjectKey } from '@/subjects/profile';
import { SUBJECT_TRAIT_KINDS } from '@/subjects/trait-schemas';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull } from 'drizzle-orm';
import { acquireControlPlaneLockSql } from './control-plane-lock';
import { ensureSubjectRoot, subjectRootId } from './ensure-subject-root';
import { hydrateSubjectRegistryFromDb } from './hydrate';
import { isGeneralFallbackFor } from './resolution-cache';

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
  | { kind: 'name_conflict'; message: string }; // → 422（custom↔builtin 撞名）

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}

async function findLiveCustomByNorm(
  db: Db,
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

  // 幂等前查（tx 外快路径；权威判定在 tx 内锁下重查——两查夹 advisory lock，
  // 快路径只省事务，不承载正确性）。
  const preExisting = await findLiveCustomByNorm(db, norm);
  if (preExisting) return { kind: 'replayed', payload: replayPayload(preExisting) };

  const id = `subj_${createId()}`;
  const now = new Date();
  try {
    const outcome = await db.transaction(async (tx): Promise<ThinCreateResult | null> => {
      await tx.execute(acquireControlPlaneLockSql);

      // 锁内权威撞名判定。builtin 撞名 = norm 已被任何 claim 占用且属主非 custom
      // 新建面（canonical/alias 同表同列占坑，PK 语义）——422 而非回放。
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
          const live = await findLiveCustomByNorm(tx as unknown as Db, norm);
          if (live) return { kind: 'replayed', payload: replayPayload(live) };
        }
        // builtin 的 canonical/alias（取名 'math'/'wenyan' 之类）、或 retired
        // custom 占坑（restore 撞名语义归 YUK-601 控制行写面）→ 拒。
        return {
          kind: 'name_conflict',
          message: `name '${displayName}' is already claimed by subject '${holder}'`,
        };
      }
      // 显示名撞 builtin（如「化学」vs「语文」——builtin 行不受 custom 部分唯一
      // 索引管辖，claim 表 canonical 又是 id 命名空间）：任何 live 行同名 →
      // builtin 拒 / custom 回放。否则 knownSubjects 分类词表出现同名双 id。
      const sameName = await tx
        .select({ id: subject.id, origin: subject.origin })
        .from(subject)
        .where(and(eq(subject.display_name_norm, norm), isNull(subject.retired_at)))
        .limit(1);
      if (sameName.length > 0) {
        if (sameName[0].origin === 'custom') {
          const live = await findLiveCustomByNorm(tx as unknown as Db, norm);
          if (live) return { kind: 'replayed', payload: replayPayload(live) };
        }
        return {
          kind: 'name_conflict',
          message: `display name '${displayName}' collides with builtin subject '${sameName[0].id}'`,
        };
      }

      // ① 控制行。
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
      // ② canonical claim = normalizeSubjectKey(**id**)（v2 §3.1 逐字：claim 表是
      // id/alias 命名空间——保护 opaque id 不被他科抢作 alias；显示名唯一性由
      // 部分唯一索引（custom）+ 上方 builtin 同名写门共同承担）。
      await tx.insert(subject_name_claim).values({
        name_norm: normalizeSubjectKey(id),
        subject_id: id,
        kind: 'canonical',
        created_at: now,
      });
      // ③ 六绑定 → general 种子 trait（零新 trait 行、零 payload 复制）。
      for (const kind of SUBJECT_TRAIT_KINDS) {
        await tx.insert(subject_trait_binding).values({
          subject_id: id,
          trait_kind: kind,
          trait_id: seedTraitId('general', kind),
        });
      }
      // ④ 建根（genesis + anchor 同事务，event-sourced from birth）。
      await ensureSubjectRoot(tx, id, displayName);
      // ⑤ control journal 'create'（rev 0，actor='owner'——thin-create 是 owner 面）。
      await tx.insert(subject_control_journal).values({
        subject_id: id,
        revision: 0,
        action: 'create',
        detail: {},
        actor: 'owner',
        created_at: now,
      });
      return null; // created
    });
    if (outcome) return outcome; // 锁内回放/拒绝分支
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
      isGeneralFallback: isGeneralFallbackFor(id), // thin-create 后恒 true（派生）
      revision: 0,
      seedRootId: subjectRootId(id),
    },
  };
}
