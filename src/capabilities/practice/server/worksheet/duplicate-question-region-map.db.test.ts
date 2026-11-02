// YUK-1523 — 同一道题在一份导出里出现两次时，区域图按发放分开着落。
//
// 入口是导出与存档路由（真实发放 + 真实 Postgres）。两次发放共享 scoring_unit_id。
// 正确图：两份都在第 1 页、各自 segment_index = 1。错误图：把第二次发放写成
// 第一次的跨页第 2 段。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { question, worksheet_region_map_page } from '@/db/schema';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import {
  WorksheetExportStateSchema,
  WorksheetPageResponseSchema,
} from '../../api/worksheet-contracts';
import {
  archiveWorksheetRegionMapRoute,
  createWorksheetExportRoute,
  getWorksheetPageRoute,
} from '../../api/worksheet-export-route';

const PDF_DIGEST = `sha256:${'ab'.repeat(32)}`;

const ANCHORS = {
  tl: { cx: 8.5, cy: 8.5, size: 5, fill: 'solid' as const, stroke_mm: null },
  tr: { cx: 201.5, cy: 8.5, size: 5, fill: 'solid' as const, stroke_mm: null },
  bl: { cx: 8.5, cy: 288.5, size: 5, fill: 'solid' as const, stroke_mm: null },
  br: { cx: 201.5, cy: 288.5, size: 5, fill: 'hollow' as const, stroke_mm: 1.2 },
};

function choiceRegion(input: {
  regionId: string;
  issuanceId: string;
  slotId: string;
  unitId: string;
  segmentIndex: number;
  optionIds: readonly string[];
  y: number;
}) {
  const mm = { x: 24, y: input.y, w: 160, h: 28 };
  return {
    region_id: input.regionId,
    kind: 'choice' as const,
    issuance_id: input.issuanceId,
    slot_id: input.slotId,
    unit_id: input.unitId,
    mark: null,
    mm,
    segment_index: input.segmentIndex,
    options: input.optionIds.map((optionId, index) => ({
      option_id: optionId,
      order: index,
      label: String.fromCharCode(65 + index),
      mm: { x: mm.x + 2 + index * 10, y: mm.y + 2, w: 6, h: 6 },
    })),
  };
}

function sheetPage(input: {
  page: number;
  of: number;
  token: string;
  regions: ReturnType<typeof choiceRegion>[];
}) {
  return {
    page: input.page,
    of: input.of,
    orientation: 'portrait' as const,
    size_mm: { w: 210, h: 297 },
    qr: {
      payload: `tlp://ws/v1/${input.token}/${input.page}/${input.of}`,
      mm: { x: 173, y: 17, w: 13, h: 13 },
    },
    anchors: ANCHORS,
    regions: input.regions,
  };
}

describe('worksheet export of the same question twice', () => {
  beforeEach(resetDb);

  // @invariant grading: two issuances of one question keep separate paper landings, so recovery cannot score one copy as the other's continuation
  // @fails-if coverage is keyed only by scoring_unit_id: the separate map (both copies, segment_index 1) is rejected and the merged continuation (second copy as segment 2) is archived
  it('archives separate landings and rejects a merged cross-page continuation', async () => {
    const db = testDb();
    const now = new Date();
    const groupId = 'wse_dup_q';
    await db.insert(question).values({
      id: groupId,
      kind: 'single_choice',
      prompt_md: '下列哪一项是质数？',
      reference_md: 'A',
      choices_md: ['2', '4', '6', '8'],
      knowledge_ids: [],
      difficulty: 2,
      source: 'manual',
      draft_status: 'active',
      variant_depth: 0,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const published = await publishQuestionGroupFromRow(db, {
      rootId: groupId,
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: 'official',
          verification: { structural_check_passed: true, independent_verification: null },
          model_slice: null,
        },
      },
      availability: 'general_pool',
      claimPolicy: 'unbounded',
      actorRef: 'test:worksheet-dup',
      now,
    });
    expect(published.status).toBe('published');

    const created = await createWorksheetExportRoute(
      new Request('http://localhost/api/worksheet-exports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotency_key: 'wse-dup-1',
          title: 'duplicate question',
          items: [{ group_id: groupId }, { group_id: groupId }],
        }),
      }),
    );
    const createdBody: unknown = await created.json();
    expect(created.status, JSON.stringify(createdBody)).toBe(201);
    const state = WorksheetExportStateSchema.parse(createdBody);
    expect(state.issued).toHaveLength(2);
    const [first, second] = state.issued;
    expect(first.group_id).toBe(groupId);
    expect(second.group_id).toBe(groupId);
    expect(first.issuance_id).not.toBe(second.issuance_id);
    expect(first.units).toHaveLength(1);
    expect(second.units).toHaveLength(1);
    const unitId = first.units[0].scoring_unit_id;
    expect(second.units[0].scoring_unit_id).toBe(unitId);
    const slotId = first.units[0].slot_refs[0];
    expect(second.units[0].slot_refs[0]).toBe(slotId);
    const optionIds = first.issuance.binding.option_order.find(
      (order) => order.slot_id === slotId,
    )?.option_ids;
    expect(optionIds?.length).toBeGreaterThan(0);
    const frozenOptions = optionIds ?? [];

    const regionFor = (
      item: (typeof state.issued)[number],
      regionId: string,
      segmentIndex: number,
      y: number,
    ) =>
      choiceRegion({
        regionId,
        issuanceId: item.issuance_id,
        slotId,
        unitId,
        segmentIndex,
        optionIds: frozenOptions,
        y,
      });

    const postMap = (pages: ReturnType<typeof sheetPage>[]) =>
      archiveWorksheetRegionMapRoute(
        new Request(`http://localhost/api/worksheet-exports/${state.export_token}/region-map`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            schema_version: 1,
            short_code: state.short_code,
            pdf_digest: PDF_DIGEST,
            web_only_units: [],
            pages,
          }),
        }),
        { token: state.export_token },
      );

    const merged = await postMap([
      sheetPage({
        page: 1,
        of: 2,
        token: state.export_token,
        regions: [regionFor(first, 'copy-a', 1, 40)],
      }),
      sheetPage({
        page: 2,
        of: 2,
        token: state.export_token,
        regions: [regionFor(second, 'copy-b', 2, 40)],
      }),
    ]);
    const mergedBody = (await merged.json()) as {
      error?: string;
      details?: { issues?: Array<{ code: string; detail: string }> };
    };
    expect(merged.status, JSON.stringify(mergedBody)).toBe(422);
    expect(mergedBody.error).toBe('invalid_region_map');
    const segmentIssues = (mergedBody.details?.issues ?? []).filter(
      (issue) => issue.code === 'segment_invalid',
    );
    expect(segmentIssues.length).toBeGreaterThan(0);
    expect(segmentIssues.some((issue) => issue.detail.includes(second.issuance_id))).toBe(true);
    expect(segmentIssues.some((issue) => issue.detail.includes('segment_index 2 != 1'))).toBe(true);
    expect(
      await db
        .select({ page: worksheet_region_map_page.page })
        .from(worksheet_region_map_page)
        .where(eq(worksheet_region_map_page.export_id, state.export_id)),
    ).toEqual([]);

    const separate = await postMap([
      sheetPage({
        page: 1,
        of: 1,
        token: state.export_token,
        regions: [regionFor(first, 'copy-a', 1, 40), regionFor(second, 'copy-b', 1, 80)],
      }),
    ]);
    const separateBody: unknown = await separate.json();
    expect(separate.status, JSON.stringify(separateBody)).toBe(201);

    const read = await getWorksheetPageRoute(new Request('http://localhost/'), {
      token: state.export_token,
      page: '1',
    });
    const readBody: unknown = await read.json();
    expect(read.status, JSON.stringify(readBody)).toBe(200);
    const page = WorksheetPageResponseSchema.parse(readBody);
    const landed = page.region_map.regions.filter((region) => region.kind === 'choice');
    expect(landed.map((region) => region.issuance_id).sort()).toEqual(
      [first.issuance_id, second.issuance_id].sort(),
    );
    expect(landed.map((region) => region.segment_index)).toEqual([1, 1]);
    expect(page.issuances.map((issuance) => issuance.issuance_id).sort()).toEqual(
      [first.issuance_id, second.issuance_id].sort(),
    );
  });
});
