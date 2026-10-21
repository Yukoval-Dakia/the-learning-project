// Effective cause-category vocabulary: declared categories plus overlay rows with
// status='active' and archived_at IS NULL. Practice owns the table; all cause entry
// points share this read.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { CauseCategoryDeclarationT } from '@/core/schema/profile-decl';
import type { Db, Tx } from '@/db/client';
import { cause_category_overlay } from '@/db/schema';
import type { SubjectProfile } from '@/subjects/profile';

type DbLike = Db | Tx;

export type CauseCategoryOverlayRow = typeof cause_category_overlay.$inferSelect;

/** 'ov_' namespace keeps overlay ids from colliding with profile-declared ids. */
export const CAUSE_OVERLAY_ID_PREFIX = 'ov_';

/**
 * Overlay row -> vocabulary candidate. Overlays carry no declaration-only fields;
 * undefined takes each optional's default.
 */
export function overlayToCandidate(row: CauseCategoryOverlayRow): CauseCategoryDeclarationT {
  return {
    id: row.id,
    label: row.label,
    ...(row.description ? { description: row.description } : {}),
  };
}

/** Active, non-archived overlays for a subject, in stable creation order. */
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
 * Fetch overlays by id regardless of status; callers decide whether a row is
 * effective.
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
 * Effective profile: declared categories followed by active overlays. Returns the
 * same object when there are no active rows.
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
