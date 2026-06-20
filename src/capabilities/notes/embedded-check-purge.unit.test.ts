// YUK-358 决定3 — 内嵌判分自测（embedded check）孤儿链真删的回归护栏。
//
// graded inline self-test 概念被 D6 + B1 裁撤；本链曾在 M5（YUK-321）等价平移成
// SPA 零消费的「半删墓碑」。决定3 把它真删：状态列 / 生成 job / attempt 路由 /
// judge / AI task / 投影全部移除。check SECTION 字段保留（Phase-3 自解释锚点）。
//
// 这些是 NEGATIVE 断言：证明孤儿链确实消失，而不是仍以墓碑形态苟活。

import { describe, expect, it } from 'vitest';

import { ArtifactGenerationStatus, ArtifactVerificationStatus } from '@/core/schema/business';
import { notesCapability } from './manifest';

describe('YUK-358 决定3 — embedded check 孤儿链真删', () => {
  it('notes manifest 不再注册 /api/embedded-check/attempt 路由', () => {
    const paths = (notesCapability.api?.routes ?? []).map((r) => r.path);
    // 非空对照：manifest 仍有路由（断言不是因为路由表整个空了）。
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).not.toContain('/api/embedded-check/attempt');
    // 任何 embedded-check 前缀都不应残留（防止平移成别名）。
    expect(paths.some((p) => p.includes('embedded-check'))).toBe(false);
  });

  it('core schema 不再导出 ArtifactEmbeddedCheckStatus 枚举', async () => {
    const businessModule = await import('@/core/schema/business');
    expect('ArtifactEmbeddedCheckStatus' in businessModule).toBe(false);
    // 仍保留的相邻状态枚举作为非空对照（断言不是因为整模块没加载）。
    expect(ArtifactGenerationStatus).toBeDefined();
    expect(ArtifactVerificationStatus).toBeDefined();
  });

  it('AI task registry 不再声明 EmbeddedCheckGenerateTask', async () => {
    const { tasks } = await import('@/ai/registry');
    expect('EmbeddedCheckGenerateTask' in tasks).toBe(false);
    // 非空对照：相邻 note task 仍在。
    expect('NoteVerifyTask' in tasks).toBe(true);
  });
});
