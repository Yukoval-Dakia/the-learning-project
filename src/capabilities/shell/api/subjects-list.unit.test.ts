// YUK-598 — GET /api/subjects 字段合同 unit（零 mock：端点只依赖 browser-safe
// registry + db-free resolution-cache，*.unit.test.ts 命名约定进 no-DB 车道）。
// 合同：逐字段裁 + server-only AI 字段绝不下发（负测是合同不是巧合）+ general
// 结构性不在列 + isGeneralFallback 派生经 resolution-cache。

import { replaceSubjectTraitResolutions } from '@/server/subjects/resolution-cache';
import { SUBJECT_TRAIT_KINDS } from '@/subjects/trait-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './subjects-list';

afterEach(() => {
  replaceSubjectTraitResolutions(new Map());
});

describe('GET /api/subjects', () => {
  it('selectable 视图：三 builtin 在列、general 结构性排除、字段集精确', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subjects: Record<string, unknown>[] };
    const ids = body.subjects.map((s) => s.id).sort();
    expect(ids).toEqual(['math', 'physics', 'yuwen']);
    for (const row of body.subjects) {
      expect(Object.keys(row).sort()).toEqual([
        'causeCategories',
        'displayName',
        'id',
        'isGeneralFallback',
        'renderConfig',
      ]);
      expect(Object.keys(row.renderConfig as object).sort()).toEqual([
        'code_highlight',
        'font_family',
        'notation',
      ]);
      const causes = row.causeCategories as Array<Record<string, unknown>>;
      expect(causes.length).toBeGreaterThan(0);
      for (const c of causes) {
        expect(Object.keys(c).sort()).toEqual(['id', 'label']); // review_priority 等不下发
      }
    }
  });

  it('server-only AI 合同字段绝不下发（负测 = 合同）', async () => {
    const res = await GET();
    const text = JSON.stringify(await res.json());
    for (const forbidden of [
      'promptFragments',
      'noteTemplate',
      'grounding',
      'judgePolicy',
      'sourceWhitelist',
      'methodology',
      'rubricGuidance',
      'schedulingHints',
      'judgeCapabilities',
    ]) {
      expect(text, `server-only 字段 '${forbidden}' 泄漏进 /api/subjects`).not.toContain(forbidden);
    }
  });

  it('isGeneralFallback 派生：无溯源 → false；全 general 种子绑定 → true', async () => {
    let body = (await (await GET()).json()) as {
      subjects: Array<{ id: string; isGeneralFallback: unknown }>;
    };
    for (const s of body.subjects) expect(s.isGeneralFallback).toBe(false);

    // 伪造 yuwen 的溯源为「六绑定全指向 general 种子」（thin-create 后的形状）。
    replaceSubjectTraitResolutions(
      new Map([
        [
          'yuwen',
          SUBJECT_TRAIT_KINDS.map((kind) => ({
            kind,
            traitId: `trt_seed_general_${kind}`,
            origin: 'builtin' as const,
            ownerSubjectId: null,
            seedVersion: '1.0.0',
            liveRevision: 0,
            effective: 0,
            degraded: null,
          })),
        ],
      ]),
    );
    body = (await (await GET()).json()) as {
      subjects: Array<{ id: string; isGeneralFallback: unknown }>;
    };
    const byId = new Map(body.subjects.map((s) => [s.id, s.isGeneralFallback]));
    expect(byId.get('yuwen')).toBe(true);
    expect(byId.get('math')).toBe(false);
  });
});
