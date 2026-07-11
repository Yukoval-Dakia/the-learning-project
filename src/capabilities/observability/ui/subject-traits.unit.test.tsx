// YUK-601 (UI design doc v1.1 §2.2-§2.4) — detail 页 SSR 覆盖（renderToString，
// node env，无 jsdom；交互路径〔确认条流转/CAS refetch〕由手工验收 + 后续 jsdom
// 载体承接）。直达加载语义：两个 query 缓存由测试显式喂入（setQueryData），组件
// 不依赖列表页在场——mock 到缓存命中 = SSR 零请求。

import { ApiError } from '@/ui/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminSubjectTraitsSurface, isCasStale } from './subject-traits';
import type { AdminSubjectRow } from './subjects';

function subjectRow(
  overrides: Partial<AdminSubjectRow> & Pick<AdminSubjectRow, 'id'>,
): AdminSubjectRow {
  return {
    displayName: overrides.id,
    origin: 'custom',
    retiredAt: null,
    isGeneralFallback: false,
    version: 'jt:x@1',
    subjectRevision: 0,
    notation: null,
    capabilityCount: 0,
    ...overrides,
  };
}

function binding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kind: 'charter',
    traitId: 'trt_seed_general_charter',
    origin: 'builtin',
    ownerSubjectId: null,
    seedVersion: '1.0.0',
    revision: 0,
    effectiveRevision: 0,
    degraded: null,
    payload: { languageStyle: '平实', methodology: '' },
    sharedBy: ['general', 'subj_x'],
    ...overrides,
  };
}

function render(subjectId: string, rows: AdminSubjectRow[], bindings: unknown[]): string {
  const qc = new QueryClient();
  qc.setQueryData(['admin-subjects'], { subjects: rows });
  qc.setQueryData(['admin-subject-traits', subjectId], { subjectRevision: 0, bindings });
  return renderToString(
    <QueryClientProvider client={qc}>
      <AdminSubjectTraitsSurface subjectId={subjectId} navigate={() => {}} />
    </QueryClientProvider>,
  );
}

describe('AdminSubjectTraitsSurface — detail 页 SSR（YUK-601 §2.2）', () => {
  it('直达渲染：header 徽标 + 六绑定行要素（kind/traitId/sharedBy/操作）', () => {
    const html = render(
      'subj_x',
      [subjectRow({ id: 'subj_x', displayName: '化学', isGeneralFallback: true })],
      [binding()],
    );
    expect(html).toContain('化学');
    expect(html).toContain('通用模式');
    expect(html).toContain('charter');
    expect(html).toContain('trt_seed_general_charter');
    // SSR 对 JSX 插值插注释分隔（共 <!-- -->2<!-- --> 科）——正则匹配。
    expect(html).toMatch(/共\s*(<!-- -->)?2(<!-- -->)?\s*科/);
    expect(html).toContain('编辑');
    expect(html).toContain('换绑');
    expect(html).toContain('历史');
    expect(html).toContain('← subjects');
  });

  it('degraded 徽标：degraded 非 null 才渲染，并示出 effective 身份（判源 = degraded 字段）', () => {
    const degraded = render(
      'subj_x',
      [subjectRow({ id: 'subj_x' })],
      [binding({ degraded: 'code_seed', effectiveRevision: 'seed:1.0.0', revision: 3 })],
    );
    expect(degraded).toContain('code_seed');
    expect(degraded).toContain('实际在用');
    expect(degraded).toContain('seed:1.0.0');

    const healthy = render(
      'subj_x',
      [subjectRow({ id: 'subj_x' })],
      [binding({ revision: 3, effectiveRevision: 3 })],
    );
    expect(healthy).not.toContain('实际在用');
  });

  it('general 特殊态：无换绑按钮、无 retire/reset、锁定说明在场（v3.2 §2.3 P1-1）', () => {
    const html = render(
      'general',
      [
        subjectRow({
          id: 'general',
          origin: 'builtin',
          isGeneralFallback: null,
          displayName: 'General',
        }),
      ],
      [binding({ sharedBy: ['general'] })],
    );
    expect(html).toContain('结构性锁定');
    expect(html).not.toContain('>换绑<');
    expect(html).not.toContain('>retire<');
    expect(html).not.toContain('>reset<');
  });

  it('retired 科目 header 挂 retired 徽标', () => {
    const html = render(
      'subj_x',
      [subjectRow({ id: 'subj_x', retiredAt: '2026-07-11T00:00:00.000Z' })],
      [binding()],
    );
    expect(html).toContain('retired');
    expect(html).toContain('restore');
  });
});

describe('isCasStale — 409 分流判据（§2.3：只认 currentRevision 形状）', () => {
  it('409 + details.currentRevision 数字 → CAS stale（refetch 分支）', () => {
    const err = new ApiError('stale subject revision', 409, 'stale_revision', {
      currentRevision: 4,
    });
    expect(isCasStale(err)).toBe(true);
  });

  it('撞名 409（无 currentRevision）与其它错误 → 非 CAS（内联直出分支）', () => {
    expect(
      isCasStale(new ApiError('name taken', 409, "display name '语文' is already taken")),
    ).toBe(false);
    expect(isCasStale(new ApiError('fan-out failed', 422, 'invalid', { issues: [] }))).toBe(false);
    expect(isCasStale(new TypeError('fetch failed'))).toBe(false);
  });
});
