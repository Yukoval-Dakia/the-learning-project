import { aiProposalKinds } from '@/core/schema/proposal';
import { validateComposition } from '@/kernel/manifest';
import { describe, expect, it } from 'vitest';
import { capabilities } from './index';

// M4 (YUK-319) 提议契约对账——subtract-from-expected 豁免（plan 裁决，注 D11）：
// record_links / record_promotion 在 capability 声明层无归属（D11 墓碑，applier 留
// src/server/proposals/legacy-record-appliers.ts 兜历史数据），从期望全集减除，
// 不要求任何包声明归属。注意「无 producer」仅指 manifest/契约归属层——工具层
// src/server/ai/tools/proposal-tools.ts 的 propose_record_links /
// propose_record_promotion 仍可写出这两个 kind（review 澄清，coderabbit minor）。
const LEGACY_TOMBSTONE_KINDS = ['record_links', 'record_promotion'];

describe('composition root', () => {
  it('passes composition validation', () => {
    expect(() => validateComposition(capabilities)).not.toThrow();
  });

  it('includes the agency capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('agency');
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

  // M4-T4：sort 后数组相等同时覆盖「每 kind 恰好一包」——并集缺失或跨包重复声明
  // 都会让两侧排序数组不等。
  it(`every live proposal kind (schema minus ${LEGACY_TOMBSTONE_KINDS.join('/')}) is declared by exactly one capability`, () => {
    const declared = capabilities.flatMap((c) => c.proposals?.kinds.map((d) => d.kind) ?? []);
    const expected = aiProposalKinds.filter((k) => !LEGACY_TOMBSTONE_KINDS.includes(k));
    expect([...declared].sort()).toEqual([...expected].sort());
  });
});
