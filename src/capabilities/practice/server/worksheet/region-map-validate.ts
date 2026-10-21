// （P5）— 区域图对冻结发放的纯校验（无 IO）。
// 输入：界面线渲染器 POST 回的整份区域图（与 PDF 同一渲染 pass 量出），
// 加上导出时逐题冻结的发放坐标（issueAssessment 落库的 parts/slots/units/
// option_order，及 revision 冻结 presentation 的输入积木绑定）。
// 校验目标：
// - 页面身份：qr payload 逐页等于 tlp://ws/v1/<token>/<页>/<总页>；
// - 区域着落：每个区域引用的 issuance/slot/unit 都在冻结范围内，配对一致
// （unit 的 slot_refs 恰含该 slot——G4 门保证已发单元单槽）；
// - 全覆盖：每个（发放, 计分单元）要么有 ≥1 个 writing/choice 区域（同一
// 发放内跨页续写 segment_index 从 1 递增、每页至多一个），要么该
// scoring_unit_id 列在 web_only_units，二者互斥（回收端区分「不在纸上」
// 与「留空」）。同一道题导出两次时 unit id 相同，段号按发放分开，不能
// 把另一次发放收成同一次的下一段；
// - 选项一致：choice 区域的选项圈恰为该槽冻结 option_order 的排列（按
// order 排序后逐位相等）——回收按 option_id 判圈，印错集合即判错题；
// - 展示绑定一致：presentation 的 option_list 绑定槽只能出 choice 圈、
// blank_input/free_area 只能出 writing 区、点选积木（matching_columns/
// break_tap/ordering）与 custom 块绑定槽只能进 web_only_units。无绑定
// 信息时按槽种类推导（single/multi_choice→choice；纯选项 select（冻结
// option_order）→choice；text/numeric/formula/open_response/blank/free
// →writing；其余→web_only）；
// - 版式硬约束：A4 尺寸与方向一致、四角标记 TL/TR/BL 实心 BR 空心、
// 矩形正面积且落在页面毫米内（容差吸收渲染舍入）。

import type {
  WorksheetRegionMapArchiveBodyT,
  WorksheetRegionT,
} from '@/capabilities/practice/api/worksheet-contracts';
import type { PresentationBlockT } from '@/core/schema/assessment/presentation';

// ---------- 冻结发放坐标（由 export-store 从发放行 + pinned revision 构建） ----------

/** 槽的打印面形态。 */
export type SlotPrintSurface = 'choice' | 'writing' | 'web_only';

export interface FrozenIssuanceScope {
  issuance_id: string;
  group_id: string;
  part_ids: readonly string[];
  /** 发出范围内的作答槽（slot_id → part/kind）。 */
  slots: ReadonlyMap<string, { part_id: string; kind: string }>;
  /** 发出范围内的计分单元（projectIssuedScoringBasis 投影；id + slot_refs）。 */
  units: ReadonlyArray<{ scoring_unit_id: string; slot_refs: readonly string[] }>;
  /** 冻结 option_order（slot_id → 呈现顺序 option_ids）。 */
  optionOrder: ReadonlyMap<string, readonly string[]>;
  /** presentation 输入积木绑定（slot_id → block kind；旧 revision 无层时为 undefined）。 */
  presentationBinders?: ReadonlyMap<string, string>;
}

export interface RegionMapIssue {
  code: string;
  detail: string;
}

// ---------- 版式常量（B 版契约–） ----------

const A4_SHORT_MM = 210;
const A4_LONG_MM = 297;
/** 页面矩形/锚点落页容差（渲染舍入）。 */
const PAGE_TOLERANCE_MM = 0.5;
/** 选项圈落在区域矩形内的容差。 */
const CONTAIN_TOLERANCE_MM = 0.1;
/** 短码前缀（人读，如 TLP-7K2Q）。 */
export const SHORT_CODE_PREFIX = 'TLP-';

export function worksheetQrPayload(token: string, page: number, of: number): string {
  return `tlp://ws/v1/${token}/${page}/${of}`;
}

// ---------- presentation 绑定 → 打印面形态 ----------

/** presentation 输入积木 → slot 的打印面形态。 */
export function presentationBinders(root: PresentationBlockT): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (block: PresentationBlockT): void => {
    switch (block.kind) {
      case 'stack':
      case 'passage_layout':
        for (const child of block.children) walk(child);
        return;
      case 'text_math':
      case 'figure':
        return;
      case 'custom':
        for (const bind of block.binds) out.set(bind.slot_id, 'custom');
        return;
      default:
        out.set(block.bind.slot_id, block.kind);
    }
  };
  walk(root);
  return out;
}

/**
 * 旧 revision（无 presentation / 无绑定积木）按槽种类推导打印面。
 * K1 统一槽（/1497）补充：
 * - blank：单空本质是书写面 → writing；
 * - free：response_class 词表中的自由作答（↔ open_response 槽）→ writing；
 * - select：纯选项形（item 无 coordinates/gap）发放时冻结 option_order
 * （missing_option_order 强校验；关系/字缝 select 不冻结且多余顺序
 * 会被 unknown_option_order_slot 拒掉）—— 有冻结顺序即可印选项圈
 * → choice，否则 v1 无纸上输入面 → web_only。
 * 与展示层绑定语义一致：option_list↔choice，
 * matching_columns/break_tap/ordering↔web_only。
 */
function legacySurface(scope: FrozenIssuanceScope, slotId: string): SlotPrintSurface {
  switch (scope.slots.get(slotId)?.kind) {
    case 'single_choice':
    case 'multi_choice':
      return 'choice';
    case 'select':
      return scope.optionOrder.has(slotId) ? 'choice' : 'web_only';
    case 'text':
    case 'numeric':
    case 'formula':
    case 'open_response':
    case 'blank':
    case 'free':
      return 'writing';
    default:
      // matching / ordering / sentence_breaks / table：v1 无纸上输入面。
      return 'web_only';
  }
}

export function slotSurface(
  scope: FrozenIssuanceScope,
  slotId: string,
): SlotPrintSurface | undefined {
  const slot = scope.slots.get(slotId);
  if (slot == null) return undefined;
  const binder = scope.presentationBinders?.get(slotId);
  if (binder != null) {
    if (binder === 'option_list') return 'choice';
    if (binder === 'blank_input' || binder === 'free_area') return 'writing';
    return 'web_only';
  }
  return legacySurface(scope, slotId);
}

// ---------- 主校验 ----------

/**
 * 纯校验：区域图 vs 冻结发放。返回 issue 列表（空 = 通过）。
 * 不做 IO；db 读取与 write-once 存档在 export-store。
 */
export function validateRegionMapArchive(
  body: WorksheetRegionMapArchiveBodyT,
  frozen: ReadonlyArray<FrozenIssuanceScope>,
  identity: { export_token: string; short_code: string },
): RegionMapIssue[] {
  const issues: RegionMapIssue[] = [];
  const push = (code: string, detail: string): void => {
    issues.push({ code, detail });
  };

  // --- 短码与导出身份 ---
  if (body.short_code !== identity.short_code) {
    push(
      'short_code_mismatch',
      `map short_code '${body.short_code}' does not match export '${identity.short_code}'`,
    );
  }

  // --- 页编号与总页一致性 ---
  const pages = body.pages;
  const counts = new Set(pages.map((page) => page.of));
  if (counts.size !== 1) {
    push('page_count_inconsistent', `pages declare different totals: ${[...counts].join(', ')}`);
  }
  const of = pages[0]?.of ?? 0;
  const seenPages = new Set<number>();
  for (const page of pages) {
    if (page.page < 1 || page.page > of) {
      push('page_out_of_range', `page ${page.page} outside 1..${of}`);
    }
    if (seenPages.has(page.page)) {
      push('page_duplicate', `page ${page.page} appears more than once`);
    }
    seenPages.add(page.page);
  }
  if (pages.length !== of || seenPages.size !== of) {
    push(
      'page_numbering_incomplete',
      `map carries ${pages.length} pages (${[...seenPages].sort((a, b) => a - b).join(',')}) but declares ${of}`,
    );
  }

  // --- 索引：已发 unit；区域按 (issuance, unit) 归段 ---
  // 同一道题导出两次时，两次发放的 scoring_unit_id 相同（part 身份来自题行）。
  // 续写与覆盖按发放分开，否则两份纸上作答会被收成一个单元的跨页续写。
  const scopeByIssuance = new Map(frozen.map((scope) => [scope.issuance_id, scope]));
  const unitIds = new Set<string>();
  for (const scope of frozen) {
    for (const unit of scope.units) unitIds.add(unit.scoring_unit_id);
  }
  const issuanceUnitKey = (issuanceId: string, unitId: string): string =>
    `${issuanceId}\0${unitId}`;
  // web_only 仍按 scoring_unit_id：共享 unit id 的两次发放列一次即同时覆盖
  // （打印面由槽种类决定，两次要么都在网页，要么都印在纸上）。纸上区域不走这条键。
  const webOnly = new Set<string>();
  for (const unitId of body.web_only_units) {
    if (webOnly.has(unitId)) {
      push('web_only_duplicate', `unit '${unitId}' listed twice in web_only_units`);
    }
    webOnly.add(unitId);
    if (!unitIds.has(unitId)) {
      push('web_only_unknown', `web_only unit '${unitId}' is not an issued scoring unit`);
    }
  }

  // --- 逐页版式与区域 ---
  const regionIds = new Set<string>();
  const regionsByIssuanceUnit = new Map<
    string,
    { issuanceId: string; unitId: string; regions: WorksheetRegionT[] }
  >();
  for (const page of pages) {
    const { w, h } = page.size_mm;
    // A4 与方向（B 版契约：竖版 210×297，横版 297×210）。
    const expectPortrait = page.orientation === 'portrait';
    const shortSide = expectPortrait ? w : h;
    const longSide = expectPortrait ? h : w;
    if (
      Math.abs(shortSide - A4_SHORT_MM) > PAGE_TOLERANCE_MM ||
      Math.abs(longSide - A4_LONG_MM) > PAGE_TOLERANCE_MM ||
      (expectPortrait && h <= w) ||
      (!expectPortrait && w <= h)
    ) {
      push(
        'page_size_mismatch',
        `page ${page.page}: size ${w}x${h}mm is not A4 ${page.orientation}`,
      );
    }

    // 身份码：逐页 payload 精确相等（token/页/总页都被校到）。
    const expectedPayload = worksheetQrPayload(identity.export_token, page.page, of);
    if (page.qr.payload !== expectedPayload) {
      push(
        'qr_payload_mismatch',
        `page ${page.page}: qr payload '${page.qr.payload}' != '${expectedPayload}'`,
      );
    }
    if (!rectPositive(page.qr.mm)) {
      push('rect_invalid', `page ${page.page}: qr rect is not positive`);
    } else if (!rectWithin(page.qr.mm, w, h)) {
      push('rect_out_of_page', `page ${page.page}: qr rect exceeds the page`);
    }

    // 四角标记：TL/TR/BL 实心、BR 空心描边（回收对位依赖）。
    const anchors = page.anchors;
    for (const [name, anchor] of [
      ['tl', anchors.tl],
      ['tr', anchors.tr],
      ['bl', anchors.bl],
    ] as const) {
      if (anchor.fill !== 'solid' || anchor.stroke_mm != null) {
        push('anchor_shape', `page ${page.page}: anchor ${name} must be solid`);
      }
      if (!pointWithin(anchor.cx, anchor.cy, w, h)) {
        push('anchor_out_of_page', `page ${page.page}: anchor ${name} center exceeds the page`);
      }
    }
    if (anchors.br.fill !== 'hollow' || anchors.br.stroke_mm == null || anchors.br.stroke_mm <= 0) {
      push('anchor_shape', `page ${page.page}: anchor br must be hollow with a stroke`);
    }
    if (!pointWithin(anchors.br.cx, anchors.br.cy, w, h)) {
      push('anchor_out_of_page', `page ${page.page}: anchor br center exceeds the page`);
    }

    for (const region of page.regions) {
      if (regionIds.has(region.region_id)) {
        push('region_id_duplicate', `region '${region.region_id}' appears more than once`);
      }
      regionIds.add(region.region_id);

      if (!rectPositive(region.mm)) {
        push('rect_invalid', `region '${region.region_id}' rect is not positive`);
      } else if (!rectWithin(region.mm, w, h)) {
        push(
          'rect_out_of_page',
          `region '${region.region_id}' on page ${page.page} exceeds the page`,
        );
      }

      if (region.kind === 'draft') continue;

      // zod superRefine 已保证非空；显式守卫让类型收窄并兜底畸形存档。
      if (region.issuance_id == null || region.slot_id == null || region.unit_id == null) {
        push(
          'region_reference_missing',
          `region '${region.region_id}' is '${region.kind}' but lacks an issuance/slot/unit reference`,
        );
        continue;
      }
      const {
        issuance_id: regionIssuanceId,
        slot_id: regionSlotId,
        unit_id: regionUnitId,
      } = region;

      // 冻结引用解析：issuance → slot → unit 三级都要落在冻结范围内。
      const scope = scopeByIssuance.get(regionIssuanceId);
      if (scope == null) {
        push(
          'unknown_issuance',
          `region '${region.region_id}' references issuance '${regionIssuanceId}' not part of this export`,
        );
        continue;
      }
      if (!scope.slots.has(regionSlotId)) {
        push(
          'slot_not_issued',
          `region '${region.region_id}' references slot '${regionSlotId}' outside the frozen issuance scope`,
        );
        continue;
      }
      const unit = scope.units.find((candidate) => candidate.scoring_unit_id === regionUnitId);
      if (unit == null) {
        push(
          'unknown_unit',
          `region '${region.region_id}' references unit '${regionUnitId}' outside the frozen issuance scope`,
        );
        continue;
      }
      if (!unit.slot_refs.includes(regionSlotId) || unit.slot_refs.length !== 1) {
        push(
          'unit_slot_mismatch',
          `region '${region.region_id}': unit '${regionUnitId}' does not bind exactly slot '${regionSlotId}'`,
        );
        continue;
      }

      // 打印面形态：choice 圈只上选项槽；writing 区只上非选项槽；点选槽不落纸。
      const surface = slotSurface(scope, regionSlotId);
      if (surface !== region.kind) {
        push(
          'region_surface_mismatch',
          `region '${region.region_id}' is '${region.kind}' but slot '${regionSlotId}' prints as '${surface ?? 'unknown'}'`,
        );
        continue;
      }

      if (region.kind === 'choice') {
        // 选项圈集合 = 冻结 option_order 的排列（按 order 排序逐位相等）。
        const frozenOrder = scope.optionOrder.get(regionSlotId);
        if (frozenOrder == null) {
          push(
            'choice_slot_expected',
            `region '${region.region_id}': slot '${regionSlotId}' has no frozen option_order`,
          );
          continue;
        }
        const options = [...(region.options ?? [])].sort((a, b) => a.order - b.order);
        const printed = options.map((option) => option.option_id);
        if (
          printed.length !== frozenOrder.length ||
          printed.some((optionId, index) => optionId !== frozenOrder[index])
        ) {
          push(
            'option_set_mismatch',
            `region '${region.region_id}': printed options [${printed.join(',')}] != frozen order [${frozenOrder.join(',')}]`,
          );
        }
        for (const option of options) {
          if (
            !rectPositive(option.mm) ||
            !rectContains(region.mm, option.mm, CONTAIN_TOLERANCE_MM)
          ) {
            push(
              'option_rect_out_of_region',
              `region '${region.region_id}': option '${option.option_id}' circle falls outside the region rect`,
            );
          }
        }
      }

      const key = issuanceUnitKey(regionIssuanceId, regionUnitId);
      const bucket = regionsByIssuanceUnit.get(key);
      if (bucket == null) {
        regionsByIssuanceUnit.set(key, {
          issuanceId: regionIssuanceId,
          unitId: regionUnitId,
          regions: [region],
        });
      } else {
        bucket.regions.push(region);
      }
    }
  }

  // --- 段号：每个（发放, 单元）每页至多一个区域；跨页按页序 segment_index = 1..k ---
  const pageOf = new Map<string, number>();
  for (const page of pages) {
    for (const region of page.regions) {
      if (region.kind !== 'draft') pageOf.set(region.region_id, page.page);
    }
  }
  for (const bucket of regionsByIssuanceUnit.values()) {
    const sorted = [...bucket.regions].sort(
      (a, b) => (pageOf.get(a.region_id) ?? 0) - (pageOf.get(b.region_id) ?? 0),
    );
    const pagesSeen = new Set<number>();
    const label = `issuance '${bucket.issuanceId}' unit '${bucket.unitId}'`;
    sorted.forEach((region, index) => {
      const pageNo = pageOf.get(region.region_id) ?? 0;
      if (pagesSeen.has(pageNo)) {
        push('segment_invalid', `${label} has multiple regions on page ${pageNo}`);
      }
      pagesSeen.add(pageNo);
      if (region.segment_index !== index + 1) {
        push(
          'segment_invalid',
          `${label}: region '${region.region_id}' segment_index ${region.segment_index} != ${index + 1}`,
        );
      }
    });
  }

  // --- 全覆盖：每个（发放, 单元）恰一着落（区域或 web_only），互斥 ---
  for (const scope of frozen) {
    for (const unit of scope.units) {
      const hasRegion =
        (regionsByIssuanceUnit.get(issuanceUnitKey(scope.issuance_id, unit.scoring_unit_id))
          ?.regions.length ?? 0) > 0;
      const isWebOnly = webOnly.has(unit.scoring_unit_id);
      const covered = `issuance '${scope.issuance_id}' unit '${unit.scoring_unit_id}'`;
      if (hasRegion && isWebOnly) {
        push('unit_double_covered', `${covered} has paper regions and is also web_only`);
      }
      if (!hasRegion && !isWebOnly) {
        // 点选/沙箱槽只能 web_only —— 报出真实缺口原因。
        const slotId = unit.slot_refs[0];
        const surface = slotId != null ? slotSurface(scope, slotId) : undefined;
        if (surface === 'web_only') {
          push(
            'web_only_required',
            `${covered} binds slot '${slotId}' with no paper input — it must be listed in web_only_units`,
          );
        } else {
          push('unit_not_covered', `${covered} has no writing/choice region and is not web_only`);
        }
      }
    }
  }

  return issues;
}

// ---------- 矩形几何 ----------

function rectPositive(rect: { w: number; h: number }): boolean {
  return rect.w > 0 && rect.h > 0;
}

function rectWithin(
  rect: { x: number; y: number; w: number; h: number },
  pw: number,
  ph: number,
): boolean {
  return (
    rect.x >= -PAGE_TOLERANCE_MM &&
    rect.y >= -PAGE_TOLERANCE_MM &&
    rect.x + rect.w <= pw + PAGE_TOLERANCE_MM &&
    rect.y + rect.h <= ph + PAGE_TOLERANCE_MM
  );
}

function pointWithin(cx: number, cy: number, pw: number, ph: number): boolean {
  return (
    cx >= -PAGE_TOLERANCE_MM &&
    cy >= -PAGE_TOLERANCE_MM &&
    cx <= pw + PAGE_TOLERANCE_MM &&
    cy <= ph + PAGE_TOLERANCE_MM
  );
}

function rectContains(
  outer: { x: number; y: number; w: number; h: number },
  inner: { x: number; y: number; w: number; h: number },
  tolerance: number,
): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance &&
    inner.y + inner.h <= outer.y + outer.h + tolerance
  );
}
