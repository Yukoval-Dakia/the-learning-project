// YUK-1523（P5）— 作答卷导出的领域编排：创建（= 逐题发放）、状态读面、
// 区域图 write-once 存档、P6 按页读面。
//
// 关键语义（对齐 docs/design/2026-10-11-worksheet-print-layout.md §4 与
// YUK-1052 发题合同）：
//   - 导出 = 发放：每道可判题经既有 issueAssessment 落一条不可变 issuance
//     （G4 门在 issueAssessment 内裁决；拒掉的题不发不导，typed 原因随
//     响应返回并冻结在导出行）。container_occurrence_ref =
//     'worksheet:<export_id>' 把发放事件与导出对上（既有索引列，无新事件面）。
//   - 幂等：idempotency_key 唯一。同 key 同 request_digest ⇒ 重放（不重发、
//     不改冻结 issuance/区域图）；同 key 异 digest ⇒ 冲突（409，不覆盖）。
//     全部题被门拒绝 ⇒ 不建导出行（返回拒绝清单）。
//   - 读面不带私有答案：practice_dto 是 §7.1 公开投影；units 只出 id +
//     slot_refs（判据/分值/执行计划不离开服务端）。重放/读面按【冻结发放】
//     重建，不重跑 serving gate —— 学习者手里已有纸卷，回收按冻结坐标对位。
//   - 区域图 write-once：按页 INSERT-only；同 digest 重 POST 幂等，异 digest
//     409。存档时对冻结发放跑 region-map-validate 的纯校验后才落库。

import { randomBytes } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type {
  WorksheetExportStateT,
  WorksheetPageResponseT,
  WorksheetRegionMapArchiveBodyT,
  WorksheetRegionMapArchivedT,
} from '@/capabilities/practice/api/worksheet-contracts';
import { WorksheetPageMap } from '@/capabilities/practice/api/worksheet-contracts';
import { canonicalHash } from '@/core/migration/canonical';
import {
  type AssessmentIssuanceT,
  Presentation,
  projectIssuedScoringBasis,
  projectPracticeIssuance,
} from '@/core/schema/assessment';
import type { ServingUnavailableReason } from '@/core/schema/assessment/serving-admission';
import type { Db, Tx } from '@/db/client';
import {
  assessment_issuance,
  question_revision,
  worksheet_export,
  worksheet_export_item,
  worksheet_region_map_page,
} from '@/db/schema';
import { issuanceRowToContract, issueAssessment, revisionRowToContract } from '../assessment/issue';
import {
  type FrozenIssuanceScope,
  type RegionMapIssue,
  SHORT_CODE_PREFIX,
  presentationBinders,
  validateRegionMapArchive,
} from './region-map-validate';

// ---------- 公开类型 ----------

/** 门（G4）拒绝的一题（与 db WorksheetRefusedItem / wire schema 结构一致）。 */
export interface WorksheetRefusedItem {
  group_id: string;
  status: string;
  serving_reason: ServingUnavailableReason | null;
  issues: string[];
}

export interface CreateWorksheetExportRequest {
  idempotency_key: string;
  title?: string;
  items: ReadonlyArray<{
    group_id: string;
    revision_id?: string;
    part_ids?: readonly string[];
    option_order_overrides?: Readonly<Record<string, readonly string[]>>;
  }>;
}

export type CreateWorksheetExportResult =
  | { status: 'created' | 'replayed'; state: WorksheetExportStateT }
  | { status: 'idempotency_conflict' }
  | { status: 'no_gradeable_questions'; refused: WorksheetRefusedItem[] };

export type ArchiveRegionMapResult =
  | { status: 'archived' | 'existing'; archive: WorksheetRegionMapArchivedT }
  | { status: 'not_found' }
  | { status: 'archive_conflict'; detail: string }
  | { status: 'invalid_map'; issues: RegionMapIssue[] };

export type WorksheetPageResult =
  | { status: 'ok'; page: WorksheetPageResponseT }
  | { status: 'not_found' }
  | { status: 'not_archived' }
  | { status: 'page_out_of_range'; page_count: number };

/** 并发同 key 抢插导出行时抛出（事务回滚；调用方重读一次收敛到重放/冲突）。 */
export class WorksheetIdempotencyRaceError extends Error {
  constructor() {
    super('worksheet export idempotency race');
    this.name = 'WorksheetIdempotencyRaceError';
  }
}

/** 全部题被门拒绝：不建导出行，携带拒绝清单上抛（事务回滚）。 */
export class NoGradeableQuestionsError extends Error {
  constructor(readonly refused: WorksheetRefusedItem[]) {
    super('no gradeable questions in worksheet export request');
    this.name = 'NoGradeableQuestionsError';
  }
}

// ---------- 身份码 ----------

/** 32 字符 base64url（192 bit 熵）—— 页面身份码 tlp://ws/v1/<token>/… 的锚。 */
function mintExportToken(): string {
  return randomBytes(24).toString('base64url');
}

/** 人读短码字母表：去 0/O/1/I，32 字符无模偏（256 % 32 === 0）。 */
const SHORT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SHORT_CODE_LEN = 4;

function randomShortCode(): string {
  const bytes = randomBytes(SHORT_CODE_LEN);
  let out = '';
  for (let i = 0; i < SHORT_CODE_LEN; i += 1) {
    const byte = bytes[i] ?? 0;
    out += SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length];
  }
  return `${SHORT_CODE_PREFIX}${out}`;
}

async function mintShortCode(tx: Tx): Promise<string> {
  // 32^4 ≈ 1e6 空间：查后插 + 唯一索引兜底；5 次不中属异常态，如实上抛。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomShortCode();
    const [hit] = await tx
      .select({ short_code: worksheet_export.short_code })
      .from(worksheet_export)
      .where(eq(worksheet_export.short_code, code))
      .limit(1);
    if (hit == null) return code;
  }
  throw new Error('worksheet export: short code space exhausted after 5 attempts');
}

// ---------- 冻结发放坐标构建（校验器与读面共用） ----------

type IssuanceRow = typeof assessment_issuance.$inferSelect;
type RevisionRow = typeof question_revision.$inferSelect;

/** issuance + pinned revision → 校验器要的冻结坐标（slots/units/option_order/绑定）。 */
async function buildFrozenScope(
  issuance: IssuanceRow,
  revision: RevisionRow,
): Promise<FrozenIssuanceScope> {
  const contract = revisionRowToContract(revision);
  const partSet = new Set(issuance.part_ids);
  const slots = new Map(
    contract.response_spec.slots
      .filter((slot) => partSet.has(slot.part_id) && slot.kind !== 'table')
      .map((slot) => [slot.slot_id, { part_id: slot.part_id, kind: slot.kind }] as const),
  );
  const units = projectIssuedScoringBasis(contract, issuance.part_ids).units.map((unit) => ({
    scoring_unit_id: unit.scoring_unit_id,
    slot_refs: [...unit.slot_refs],
  }));
  const shapedPresentation = contract.presentation
    ? Presentation.safeParse(contract.presentation)
    : null;
  return {
    issuance_id: issuance.issuance_id,
    group_id: revision.group_id,
    part_ids: [...issuance.part_ids],
    slots,
    units,
    optionOrder: new Map(
      issuance.option_order.map((order) => [order.slot_id, [...order.option_ids]]),
    ),
    presentationBinders: shapedPresentation?.success
      ? presentationBinders(shapedPresentation.data.root)
      : undefined,
  };
}

async function loadFrozenScopes(
  db: Db | Tx,
  issuanceIds: readonly string[],
): Promise<FrozenIssuanceScope[]> {
  if (issuanceIds.length === 0) return [];
  const ids = [...new Set(issuanceIds)];
  const issuanceRows = await db
    .select()
    .from(assessment_issuance)
    .where(inArray(assessment_issuance.issuance_id, ids));
  const revisionRows = await db
    .select()
    .from(question_revision)
    .where(
      inArray(
        question_revision.revision_id,
        issuanceRows.map((row) => row.revision_id),
      ),
    );
  const revisionByIssuance = new Map(
    issuanceRows.map((row) => {
      const revision = revisionRows.find((candidate) => candidate.revision_id === row.revision_id);
      if (revision == null) {
        throw new Error(
          `worksheet export: pinned revision '${row.revision_id}' missing for issuance '${row.issuance_id}'`,
        );
      }
      return [row.issuance_id, revision] as const;
    }),
  );
  const scopes: FrozenIssuanceScope[] = [];
  for (const issuanceId of ids) {
    const issuance = issuanceRows.find((row) => row.issuance_id === issuanceId);
    const revision = revisionByIssuance.get(issuanceId);
    if (issuance == null || revision == null) continue; // 调用方给的 id 集合超集时如实跳过
    scopes.push(await buildFrozenScope(issuance, revision));
  }
  return scopes;
}

/** 冻结发放 → P6 读面的公开坐标（无私有答案）。 */
function frozenScopeToContract(scope: FrozenIssuanceScope): {
  issuance_id: string;
  group_id: string;
  part_ids: string[];
  option_order: Array<{ slot_id: string; option_ids: string[] }>;
  slots: Array<{ slot_id: string; part_id: string; kind: string }>;
  units: Array<{ scoring_unit_id: string; slot_refs: string[] }>;
} {
  return {
    issuance_id: scope.issuance_id,
    group_id: scope.group_id,
    part_ids: [...scope.part_ids],
    option_order: [...scope.optionOrder.entries()].map(([slot_id, option_ids]) => ({
      slot_id,
      option_ids: [...option_ids],
    })),
    slots: [...scope.slots.entries()].map(([slot_id, slot]) => ({
      slot_id,
      part_id: slot.part_id,
      kind: slot.kind,
    })),
    units: scope.units.map((unit) => ({
      scoring_unit_id: unit.scoring_unit_id,
      slot_refs: [...unit.slot_refs],
    })),
  };
}

// ---------- 状态快照（创建/重放/读面共用） ----------

type ExportRow = typeof worksheet_export.$inferSelect;

async function buildIssuedItem(
  db: Db | Tx,
  item: typeof worksheet_export_item.$inferSelect,
): Promise<WorksheetExportStateT['issued'][number]> {
  const [issuance] = await db
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, item.issuance_id))
    .limit(1);
  if (issuance == null) {
    throw new Error(`worksheet export '${item.export_id}': issuance '${item.issuance_id}' missing`);
  }
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, issuance.revision_id))
    .limit(1);
  if (revision == null) {
    throw new Error(
      `worksheet export '${item.export_id}': pinned revision '${issuance.revision_id}' missing`,
    );
  }
  const revisionContract = revisionRowToContract(revision);
  const issuanceContract: AssessmentIssuanceT = issuanceRowToContract(issuance);
  return {
    position: item.position,
    group_id: item.group_id,
    issuance_id: issuance.issuance_id,
    issuance: issuanceContract,
    practice_dto: projectPracticeIssuance(revisionContract, issuanceContract),
    units: projectIssuedScoringBasis(revisionContract, issuance.part_ids).units.map((unit) => ({
      scoring_unit_id: unit.scoring_unit_id,
      slot_refs: [...unit.slot_refs],
    })),
  };
}

async function buildExportState(
  db: Db | Tx,
  row: ExportRow,
  status: 'created' | 'replayed',
): Promise<WorksheetExportStateT> {
  const items = await db
    .select()
    .from(worksheet_export_item)
    .where(eq(worksheet_export_item.export_id, row.export_id))
    .orderBy(worksheet_export_item.position);
  const pages = await db
    .select({
      page: worksheet_region_map_page.page,
      page_count: worksheet_region_map_page.page_count,
      map_digest: worksheet_region_map_page.map_digest,
      archived_at: worksheet_region_map_page.archived_at,
    })
    .from(worksheet_region_map_page)
    .where(eq(worksheet_region_map_page.export_id, row.export_id))
    .orderBy(worksheet_region_map_page.page);
  const issued: WorksheetExportStateT['issued'] = [];
  for (const item of items) {
    issued.push(await buildIssuedItem(db, item));
  }
  return {
    status,
    export_id: row.export_id,
    export_token: row.export_token,
    short_code: row.short_code,
    title: row.title,
    page_count: row.page_count,
    archived_at: row.archived_at?.toISOString() ?? null,
    issued,
    refused: row.refused,
    pages: pages.map((page) => ({
      page: page.page,
      page_count: page.page_count,
      map_digest: page.map_digest,
      archived_at: page.archived_at.toISOString(),
    })),
    web_only_units: row.web_only_units ?? null,
  };
}

// ---------- 1) 创建导出（= 逐题发放） ----------

export async function createWorksheetExport(
  db: Db,
  request: CreateWorksheetExportRequest,
): Promise<CreateWorksheetExportResult> {
  const requestDigest = canonicalHash({
    v: 1,
    title: request.title ?? '',
    items: request.items,
  });

  return db.transaction(async (tx) => {
    // 幂等锚先行：同 key 已存在 ⇒ 重放/冲突，绝不重发。
    const [existing] = await tx
      .select()
      .from(worksheet_export)
      .where(eq(worksheet_export.idempotency_key, request.idempotency_key))
      .limit(1);
    if (existing != null) {
      if (existing.request_digest !== requestDigest) {
        return { status: 'idempotency_conflict' } as const;
      }
      return {
        status: 'replayed',
        state: await buildExportState(tx, existing, 'replayed'),
      } as const;
    }

    // 抢插导出行（唯一键原子占位；并发同 key ⇒ race 哨兵 → 回滚重读）。
    const exportId = `wse_${createId()}`;
    const inserted = await tx
      .insert(worksheet_export)
      .values({
        export_id: exportId,
        export_token: mintExportToken(),
        short_code: await mintShortCode(tx),
        idempotency_key: request.idempotency_key,
        request_digest: `sha256:${requestDigest}`,
        title: request.title ?? '',
        refused: [],
      })
      .onConflictDoNothing({ target: worksheet_export.idempotency_key })
      .returning({ export_id: worksheet_export.export_id });
    if (inserted.length === 0) {
      throw new WorksheetIdempotencyRaceError();
    }

    // 逐题过既有发放（G4 门在 issueAssessment 内裁决）。
    const itemRows: Array<typeof worksheet_export_item.$inferInsert> = [];
    const refused: WorksheetRefusedItem[] = [];
    const issuedResults: Array<{
      position: number;
      group_id: string;
      issuance: AssessmentIssuanceT;
    }> = [];
    for (const item of request.items) {
      const out = await issueAssessment(tx, {
        group_id: item.group_id,
        revision_id: item.revision_id,
        part_ids: item.part_ids != null ? [...item.part_ids] : undefined,
        option_order_overrides:
          item.option_order_overrides != null
            ? Object.fromEntries(
                Object.entries(item.option_order_overrides).map(([slot, order]) => [
                  slot,
                  [...order],
                ]),
              )
            : undefined,
        container_occurrence_ref: `worksheet:${exportId}`,
        actorRef: 'api:worksheet-export',
      });
      if (out.status === 'issued' || out.status === 'replayed') {
        const position = issuedResults.length;
        issuedResults.push({
          position,
          group_id: item.group_id,
          issuance: out.issuance,
        });
        itemRows.push({
          export_id: exportId,
          position,
          group_id: item.group_id,
          issuance_id: out.issuance.issuance_id,
        });
      } else {
        // 共享 status 字面量的判别成员：`||` 反向收窄不可靠，按声明键取值。
        const servingReason = 'serving_reason' in out ? (out.serving_reason ?? null) : null;
        const refusalIssues = 'issues' in out ? (out.issues ?? []) : [];
        refused.push({
          group_id: item.group_id,
          status: out.status,
          serving_reason: servingReason,
          issues: refusalIssues,
        });
      }
    }
    if (issuedResults.length === 0) {
      // 全拒 ⇒ 不建导出（回滚占位行），拒绝清单随 422 返回。
      throw new NoGradeableQuestionsError(refused);
    }
    await tx.insert(worksheet_export_item).values(itemRows);
    await tx
      .update(worksheet_export)
      .set({ refused })
      .where(eq(worksheet_export.export_id, exportId));

    const [row] = await tx
      .select()
      .from(worksheet_export)
      .where(eq(worksheet_export.export_id, exportId))
      .limit(1);
    if (row == null) {
      throw new Error(`worksheet export '${exportId}' vanished inside its own transaction`);
    }
    return {
      status: 'created',
      state: await buildExportState(tx, row, 'created'),
    } as const;
  });
}

// ---------- 2) 状态读面（token） ----------

export async function readWorksheetExport(
  db: Db | Tx,
  token: string,
): Promise<WorksheetExportStateT | null> {
  const [row] = await db
    .select()
    .from(worksheet_export)
    .where(eq(worksheet_export.export_token, token))
    .limit(1);
  if (row == null) return null;
  // 读面如实标注 status（created 语义 = 首建快照；读面不伪装重放）。
  return buildExportState(db, row, 'created');
}

// ---------- 3) 区域图存档（write-once，按页） ----------

export async function archiveWorksheetRegionMap(
  db: Db,
  token: string,
  body: WorksheetRegionMapArchiveBodyT,
): Promise<ArchiveRegionMapResult> {
  const now = new Date();

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(worksheet_export)
      .where(eq(worksheet_export.export_token, token))
      .limit(1);
    if (row == null) return { status: 'not_found' } as const;

    const of = body.pages[0]?.of ?? 0;
    const pageDigests = body.pages.map((page) => ({
      page: page.page,
      page_count: page.of,
      digest: `sha256:${canonicalHash(page)}`,
    }));
    const webOnlyDigest = canonicalHash([...body.web_only_units]);

    // 已存档：整份幂等比对（页 digest + web_only 集合）——一致 existing，否则冲突。
    if (row.archived_at != null) {
      const existingPages = await tx
        .select({
          page: worksheet_region_map_page.page,
          page_count: worksheet_region_map_page.page_count,
          map_digest: worksheet_region_map_page.map_digest,
        })
        .from(worksheet_region_map_page)
        .where(eq(worksheet_region_map_page.export_id, row.export_id))
        .orderBy(worksheet_region_map_page.page);
      const samePages =
        existingPages.length === pageDigests.length &&
        existingPages.every(
          (existing, index) =>
            existing.page === pageDigests[index]?.page &&
            existing.page_count === pageDigests[index]?.page_count &&
            existing.map_digest === pageDigests[index]?.digest,
        );
      const sameWebOnly = canonicalHash([...(row.web_only_units ?? [])]) === webOnlyDigest;
      if (samePages && sameWebOnly) {
        return {
          status: 'existing',
          archive: {
            status: 'existing',
            export_id: row.export_id,
            export_token: row.export_token,
            page_count: of,
            web_only_units: [...(row.web_only_units ?? [])],
            pages: pageDigests.map((page) => ({ page: page.page, map_digest: page.digest })),
          },
        } as const;
      }
      return {
        status: 'archive_conflict',
        detail:
          'region map archive is frozen (write-once): a different map or web_only_units set was already archived for this export',
      } as const;
    }

    // 对冻结发放校验（纯函数；issues 原样上抛给 422）。
    const items = await tx
      .select({ issuance_id: worksheet_export_item.issuance_id })
      .from(worksheet_export_item)
      .where(eq(worksheet_export_item.export_id, row.export_id));
    const scopes = await loadFrozenScopes(
      tx,
      items.map((item) => item.issuance_id),
    );
    const issues = validateRegionMapArchive(body, scopes, {
      export_token: row.export_token,
      short_code: row.short_code,
    });
    if (issues.length > 0) {
      return { status: 'invalid_map', issues } as const;
    }

    // 按页 write-once 落库 + 导出行存档列一次冻结。
    const pageByNumber = new Map(body.pages.map((page) => [page.page, page] as const));
    for (const page of pageDigests) {
      const pageMap = pageByNumber.get(page.page);
      if (pageMap == null) {
        return {
          status: 'archive_conflict',
          detail: `page ${page.page} digest carries no map slice`,
        } as const;
      }
      const inserted = await tx
        .insert(worksheet_region_map_page)
        .values({
          export_id: row.export_id,
          page: page.page,
          page_count: page.page_count,
          region_map: pageMap,
          map_digest: page.digest,
          archived_at: now,
        })
        .onConflictDoNothing({
          target: [worksheet_region_map_page.export_id, worksheet_region_map_page.page],
        })
        .returning({ page: worksheet_region_map_page.page });
      if (inserted.length === 0) {
        return {
          status: 'archive_conflict',
          detail: `page ${page.page} already archived with a different map`,
        } as const;
      }
    }
    const finalized = await tx
      .update(worksheet_export)
      .set({
        web_only_units: [...new Set(body.web_only_units)],
        page_count: of,
        archived_at: now,
      })
      .where(
        and(
          eq(worksheet_export.export_id, row.export_id),
          // 只在未存档行上冻结（row.archived_at 为 NULL 分支专用；并发存档互斥）。
          isNull(worksheet_export.archived_at),
        ),
      )
      .returning({ export_id: worksheet_export.export_id });
    if (finalized.length === 0) {
      return {
        status: 'archive_conflict',
        detail: 'export was archived concurrently',
      } as const;
    }
    return {
      status: 'archived',
      archive: {
        status: 'archived',
        export_id: row.export_id,
        export_token: row.export_token,
        page_count: of,
        web_only_units: [...new Set(body.web_only_units)],
        pages: pageDigests.map((page) => ({ page: page.page, map_digest: page.digest })),
      },
    } as const;
  });
}

// ---------- 4) P6 按页读面（token + page） ----------

export async function readWorksheetPage(
  db: Db | Tx,
  token: string,
  page: number,
): Promise<WorksheetPageResult> {
  const [row] = await db
    .select()
    .from(worksheet_export)
    .where(eq(worksheet_export.export_token, token))
    .limit(1);
  if (row == null) return { status: 'not_found' };
  if (row.archived_at == null || row.page_count == null) return { status: 'not_archived' };
  if (page < 1 || page > row.page_count) {
    return { status: 'page_out_of_range', page_count: row.page_count };
  }
  const [pageRow] = await db
    .select()
    .from(worksheet_region_map_page)
    .where(
      and(
        eq(worksheet_region_map_page.export_id, row.export_id),
        eq(worksheet_region_map_page.page, page),
      ),
    )
    .limit(1);
  if (pageRow == null) return { status: 'not_archived' };

  const parsed = WorksheetPageMap.safeParse(pageRow.region_map);
  if (!parsed.success) {
    // 存档前已过后端校验；坏行 = 跨库破坏，fail-loud 而非静默降级。
    throw new Error(
      `worksheet export '${row.export_id}' page ${page}: archived region map is malformed`,
    );
  }
  const issuanceIds = [
    ...new Set(
      parsed.data.regions
        .filter(
          (region): region is typeof region & { issuance_id: string } =>
            region.kind !== 'draft' && region.issuance_id != null,
        )
        .map((region) => region.issuance_id),
    ),
  ];
  const scopes = await loadFrozenScopes(db, issuanceIds);
  return {
    status: 'ok',
    page: {
      export_id: row.export_id,
      export_token: row.export_token,
      short_code: row.short_code,
      page,
      page_count: pageRow.page_count,
      region_map: parsed.data,
      issuances: scopes.map(frozenScopeToContract),
    },
  };
}
