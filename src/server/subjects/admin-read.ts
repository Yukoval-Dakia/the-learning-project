// YUK-601 (v3.2 §3.5) — 管理读面：编辑器/badge 的 HTTP 表面的业务层。
// 四个读函数对应四个 GET 端点（route 壳在 observability capability）：
//   listAdminSubjects        → GET /api/admin/subjects（既有 slim 面扩容）
//   getAdminSubjectTraits    → GET /api/admin/subjects/:id/traits
//   listAdminTraits          → GET /api/admin/traits?kind=
//   getTraitJournal          → GET /api/admin/traits/:id/journal
//
// 读面纪律：
// - 枚举全量走 DB（含 general 与 retired——编辑器选科数据源，GET /api/subjects
//   只给 selectable 不够）；version 组合串/notation/capabilityCount 从活 registry
//   取（装配产物，DB 无此列），未装配 → null 不编造。
// - `subjectRevision`（数字 CAS 轴）随两个 subject 读端点下发——写面全部要
//   `expectedSubjectRevision`，UI 首次提交的初始值只能从读面来（design doc
//   2026-07-11 v1.1 owner review P1；409 的 currentRevision 只在冲突时出现）。
// - revision（live）vs effectiveRevision（实际采用）vs degraded 三元事实来自
//   resolution-cache（hydrate 每轮整体替换）；缓存缺位（未水合窗口）回落
//   live revision + degraded:null，不臆造降级态。

import type { Db } from '@/db/client';
import { subject, subject_trait, subject_trait_binding, subject_trait_journal } from '@/db/schema';
import { ApiError } from '@/server/http/errors';
import {
  type TraitDegradation,
  getSubjectTraitResolutions,
  isGeneralFallbackFor,
} from '@/server/subjects/resolution-cache';
import { getDefaultSubjectRegistry } from '@/subjects/profile';
import type { TraitVersionComponent } from '@/subjects/trait-compose';
import { SUBJECT_TRAIT_KINDS, type SubjectTraitKind } from '@/subjects/trait-schemas';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';

export interface AdminSubjectListRow {
  id: string;
  displayName: string;
  origin: 'builtin' | 'custom';
  retiredAt: string | null;
  /** 派生布尔（v3 §2.3）；general 恒 null（自身豁免）。 */
  isGeneralFallback: boolean | null;
  /** 装配身份组合串（jt:…）；未装配（registry 无此科）→ null。 */
  version: string | null;
  /** 控制行 CAS 轴——写面 expectedSubjectRevision 的首次提交值。 */
  subjectRevision: number;
  // 既有 slim 面消费字段（/admin/subjects 列表页），保留防断。
  notation: string | null;
  capabilityCount: number;
}

export async function listAdminSubjects(db: Db): Promise<AdminSubjectListRow[]> {
  const registry = getDefaultSubjectRegistry();
  const rows = await db.select().from(subject).orderBy(asc(subject.created_at), asc(subject.id));
  return rows.map((row) => {
    const profile = registry.get(row.id);
    return {
      id: row.id,
      displayName: row.display_name,
      origin: row.origin,
      retiredAt: row.retired_at ? row.retired_at.toISOString() : null,
      isGeneralFallback: isGeneralFallbackFor(row.id),
      version: profile?.version ?? null,
      subjectRevision: row.revision,
      notation: profile?.renderConfig.notation ?? null,
      capabilityCount: profile?.judgeCapabilities.length ?? 0,
    };
  });
}

export interface AdminTraitBindingRow {
  kind: SubjectTraitKind;
  traitId: string;
  origin: 'builtin' | 'custom';
  ownerSubjectId: string | null;
  seedVersion: string | null;
  /** live 行 revision。 */
  revision: number;
  /** 实际采用的身份（降级中 ≠ revision）；未水合缓存缺位时回落 live revision。 */
  effectiveRevision: TraitVersionComponent['effective'];
  degraded: TraitDegradation;
  payload: unknown;
  /** 绑定此 trait 的全部科目（含本科）——共享写波及面提示的数据源。 */
  sharedBy: string[];
}

export interface AdminSubjectTraits {
  subjectRevision: number;
  bindings: AdminTraitBindingRow[];
}

/** null = subject 不存在（route 映射 404）。 */
export async function getAdminSubjectTraits(
  db: Db,
  subjectId: string,
): Promise<AdminSubjectTraits | null> {
  const subjectRows = await db
    .select({ revision: subject.revision })
    .from(subject)
    .where(eq(subject.id, subjectId))
    .limit(1);
  const subjectRow = subjectRows[0];
  if (!subjectRow) return null;

  const bindingRows = await db
    .select({
      kind: subject_trait_binding.trait_kind,
      traitId: subject_trait_binding.trait_id,
      origin: subject_trait.origin,
      ownerSubjectId: subject_trait.owner_subject_id,
      seedVersion: subject_trait.seed_version,
      revision: subject_trait.revision,
      payload: subject_trait.payload,
    })
    .from(subject_trait_binding)
    .innerJoin(subject_trait, eq(subject_trait.id, subject_trait_binding.trait_id))
    .where(eq(subject_trait_binding.subject_id, subjectId));

  const traitIds = bindingRows.map((b) => b.traitId);
  const sharers =
    traitIds.length > 0
      ? await db
          .select({
            traitId: subject_trait_binding.trait_id,
            subjectId: subject_trait_binding.subject_id,
          })
          .from(subject_trait_binding)
          .where(inArray(subject_trait_binding.trait_id, traitIds))
          .orderBy(asc(subject_trait_binding.subject_id))
      : [];
  const sharedByTrait = new Map<string, string[]>();
  for (const s of sharers) {
    const list = sharedByTrait.get(s.traitId) ?? [];
    list.push(s.subjectId);
    sharedByTrait.set(s.traitId, list);
  }

  const resolutionByKind = new Map(
    (getSubjectTraitResolutions().get(subjectId) ?? []).map((r) => [r.kind, r]),
  );

  const kindOrder = new Map(SUBJECT_TRAIT_KINDS.map((k, i) => [k, i]));
  const bindings = bindingRows
    .map((b): AdminTraitBindingRow => {
      const resolution = resolutionByKind.get(b.kind);
      return {
        kind: b.kind,
        traitId: b.traitId,
        origin: b.origin,
        ownerSubjectId: b.ownerSubjectId,
        seedVersion: b.seedVersion,
        revision: b.revision,
        effectiveRevision: resolution?.effective ?? b.revision,
        degraded: resolution?.degraded ?? null,
        payload: b.payload,
        sharedBy: sharedByTrait.get(b.traitId) ?? [subjectId],
      };
    })
    .sort((a, b) => (kindOrder.get(a.kind) ?? 99) - (kindOrder.get(b.kind) ?? 99));

  return { subjectRevision: subjectRow.revision, bindings };
}

export interface AdminTraitCatalogRow {
  traitId: string;
  origin: 'builtin' | 'custom';
  ownerSubjectId: string | null;
  seedVersion: string | null;
  revision: number;
  /** 绑定此 trait 的科目——换绑选择器展示「谁在用」。 */
  boundBy: string[];
}

/** 跨科 trait 目录（换绑选择器数据源）。kind 由 route 校验后传入。 */
export async function listAdminTraits(
  db: Db,
  kind: SubjectTraitKind,
): Promise<AdminTraitCatalogRow[]> {
  const traits = await db
    .select({
      traitId: subject_trait.id,
      origin: subject_trait.origin,
      ownerSubjectId: subject_trait.owner_subject_id,
      seedVersion: subject_trait.seed_version,
      revision: subject_trait.revision,
    })
    .from(subject_trait)
    .where(eq(subject_trait.trait_kind, kind))
    .orderBy(asc(subject_trait.id));

  const ids = traits.map((t) => t.traitId);
  const binders =
    ids.length > 0
      ? await db
          .select({
            traitId: subject_trait_binding.trait_id,
            subjectId: subject_trait_binding.subject_id,
          })
          .from(subject_trait_binding)
          .where(inArray(subject_trait_binding.trait_id, ids))
          .orderBy(asc(subject_trait_binding.subject_id))
      : [];
  const boundByTrait = new Map<string, string[]>();
  for (const b of binders) {
    const list = boundByTrait.get(b.traitId) ?? [];
    list.push(b.subjectId);
    boundByTrait.set(b.traitId, list);
  }

  return traits.map((t) => ({ ...t, boundBy: boundByTrait.get(t.traitId) ?? [] }));
}

export interface TraitJournalRow {
  revision: number;
  action: 'create' | 'edit' | 'rollback' | 'reconcile' | 'reset_to_seed' | 'fork_source';
  actor: 'owner' | 'migrate';
  payloadSchemaVersion: number;
  seedVersion: string | null;
  sourceTraitId: string | null;
  sourceRevision: number | null;
  rolledBackFrom: number | null;
  changeSeq: number;
  createdAt: string;
}

/**
 * append-only 历史，倒序（rollback UI 数据源）。null = trait 不存在（404）。
 * 不下发 payload——doc v1.1 §2.2 裁定 journal 区为纯 revision 列表（diff 查看器
 * 是 owner 点名后的 follow-up）；rollback 提交只需 targetRevision。
 */
export async function getTraitJournal(db: Db, traitId: string): Promise<TraitJournalRow[] | null> {
  const allRows: TraitJournalRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await getTraitJournalPage(db, traitId, { limit: 200, cursor });
    if (!page) return null;
    allRows.push(...page.rows);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return allRows;
}

interface TraitJournalCursor {
  traitId: string;
  revision: number;
}

function encodeTraitJournalCursor(traitId: string, revision: number): string {
  return Buffer.from(JSON.stringify({ trait_id: traitId, revision })).toString('base64url');
}

function decodeTraitJournalCursor(cursor: string, traitId: string): TraitJournalCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      trait_id?: unknown;
      revision?: unknown;
    };
    if (
      parsed.trait_id !== traitId ||
      typeof parsed.revision !== 'number' ||
      !Number.isInteger(parsed.revision)
    ) {
      throw new Error('cursor does not match the trait journal');
    }
    return { traitId, revision: parsed.revision };
  } catch (err) {
    throw new ApiError(
      'invalid_cursor',
      `invalid trait journal cursor: ${(err as Error).message}`,
      400,
    );
  }
}

export async function getTraitJournalPage(
  db: Db,
  traitId: string,
  options: { limit: number; cursor?: string },
): Promise<{ rows: TraitJournalRow[]; next_cursor: string | null } | null> {
  const exists = await db
    .select({ id: subject_trait.id })
    .from(subject_trait)
    .where(eq(subject_trait.id, traitId))
    .limit(1);
  if (exists.length === 0) return null;

  const cursor = options.cursor ? decodeTraitJournalCursor(options.cursor, traitId) : null;
  const limit = Math.min(Math.max(options.limit, 1), 200);

  const fetchedRows = await db
    .select({
      revision: subject_trait_journal.revision,
      action: subject_trait_journal.action,
      actor: subject_trait_journal.actor,
      payloadSchemaVersion: subject_trait_journal.payload_schema_version,
      seedVersion: subject_trait_journal.seed_version,
      sourceTraitId: subject_trait_journal.source_trait_id,
      sourceRevision: subject_trait_journal.source_revision,
      rolledBackFrom: subject_trait_journal.rolled_back_from,
      changeSeq: subject_trait_journal.change_seq,
      createdAt: subject_trait_journal.created_at,
    })
    .from(subject_trait_journal)
    .where(
      cursor
        ? and(
            eq(subject_trait_journal.trait_id, traitId),
            lt(subject_trait_journal.revision, cursor.revision),
          )
        : eq(subject_trait_journal.trait_id, traitId),
    )
    .orderBy(desc(subject_trait_journal.revision))
    .limit(limit + 1);

  const hasMore = fetchedRows.length > limit;
  const rows = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
  const last = rows.at(-1);

  return {
    rows: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    next_cursor: hasMore && last ? encodeTraitJournalCursor(traitId, last.revision) : null,
  };
}
