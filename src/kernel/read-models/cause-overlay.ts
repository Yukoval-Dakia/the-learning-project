// YUK-1016 / 454-B — cause_category_overlay 读面（跨 capability 共享投影）。
//
// 表归 Practice 所有（唯一写路径：`cause_category` proposal 的 accept applier），
// 但「生效错因词表 = 声明 ∪ overlay.active」是所有 cause 入口都要用的投影——
// ingestion（mistakes / import-completion / mistake_enroll）与 practice
// （attribution / variant）都经这里合并，所以放 kernel read-models。
//
// 生效语义：status='active' 且 archived_at IS NULL。draft / archived 行不进任何
// 读取点。

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { CauseCategoryDeclarationT } from '@/core/schema/profile-decl';
import type { Db, Tx } from '@/db/client';
import { cause_category_overlay } from '@/db/schema';
import type { SubjectProfile } from '@/subjects/profile';

type DbLike = Db | Tx;

export type CauseCategoryOverlayRow = typeof cause_category_overlay.$inferSelect;

/** `ov_` 命名空间——防撞 profile 声明的类目 id（`misc_` 前缀的同款手法）。 */
export const CAUSE_OVERLAY_ID_PREFIX = 'ov_';

/**
 * Overlay 行 → 词表候选形状。overlay 不携带 meta_cause_prior / variant_targetable
 * / rating_lean 等声明字段——它们在 CauseCategoryDeclarationT 上都是 optional，
 * undefined 走各自默认（prior→null、targetable→true、lean→neutral）。
 */
export function overlayToCandidate(row: CauseCategoryOverlayRow): CauseCategoryDeclarationT {
  return {
    id: row.id,
    label: row.label,
    ...(row.description ? { description: row.description } : {}),
  };
}

/**
 * 该 subject 的全部 active overlay 类目（合并词表的来源）。
 * 只读 status='active' 且未归档的行；按 created_at 稳定排序，保证候选序确定。
 */
export async function listActiveCauseCategoryOverlays(
  db: DbLike,
  subjectId: string,
): Promise<CauseCategoryOverlayRow[]> {
  return db
    .select()
    .from(cause_category_overlay)
    .where(
      and(
        eq(cause_category_overlay.subject_id, subjectId),
        eq(cause_category_overlay.status, 'active'),
        isNull(cause_category_overlay.archived_at),
      ),
    )
    .orderBy(cause_category_overlay.created_at, cause_category_overlay.id);
}

/**
 * 按 id 取 overlay 行（任意 status/归档态）——variant targetability 与 retract
 * applier 的解析面。返回行由调用方自行判定 status==='active' && archived_at===null。
 */
export async function getCauseCategoryOverlaysByIds(
  db: DbLike,
  ids: readonly string[],
): Promise<CauseCategoryOverlayRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(cause_category_overlay)
    .where(inArray(cause_category_overlay.id, [...ids]));
}

/**
 * 生效 profile = 声明词表 ∪ overlay.active（追加在声明之后，序确定）。
 * 无 active 行时**同引用返回**——等价语义不制造多余对象。
 */
export async function withActiveCauseCategoryOverlays(
  db: DbLike,
  profile: SubjectProfile,
): Promise<SubjectProfile> {
  const rows = await listActiveCauseCategoryOverlays(db, profile.id);
  if (rows.length === 0) return profile;
  return {
    ...profile,
    causeCategories: [...profile.causeCategories, ...rows.map(overlayToCandidate)],
  };
}
