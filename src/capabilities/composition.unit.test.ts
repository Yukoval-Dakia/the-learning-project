import { aiProposalKinds } from '@/core/schema/proposal';
import { validateComposition } from '@/kernel/manifest';
import { describe, expect, it } from 'vitest';
import { capabilities } from './index';

// M4 (YUK-319) 提议契约对账——subtract-from-expected 豁免（plan 裁决，注 D11）：
// record_links / record_promotion 无活 producer（D11 墓碑，applier 留
// src/server/proposals/legacy-record-appliers.ts 兜历史数据），从期望全集减除，
// 不要求任何包声明归属。
const LEGACY_TOMBSTONE_KINDS = ['record_links', 'record_promotion'];

describe('composition root', () => {
  it('passes composition validation', () => {
    expect(() => validateComposition(capabilities)).not.toThrow();
  });

  it('includes the agent-notes pilot capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('agent-notes');
  });

  it('includes the practice capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('practice');
  });

  it('includes the ingestion capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('ingestion');
  });

  it('declares only schema-known proposal kinds', () => {
    const declared = capabilities.flatMap((c) => c.proposals?.kinds.map((d) => d.kind) ?? []);
    const known = new Set<string>(aiProposalKinds);
    expect(declared.filter((kind) => !known.has(kind))).toEqual([]);
  });

  // T4 各包补齐 proposals.kinds 归属声明后升级为真测试（plan Task 4「kernel 对账测试
  // 此时转绿」——T1 落 todo 占位保持逐 commit 全绿）。断言形态：
  //   全包声明并集 === new Set(aiProposalKinds) − LEGACY_TOMBSTONE_KINDS
  it.todo(
    `every live proposal kind (schema minus ${LEGACY_TOMBSTONE_KINDS.join('/')}) is declared by exactly one capability`,
  );
});
