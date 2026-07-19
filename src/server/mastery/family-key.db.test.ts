// YUK-372 L3 — family_key 读/写两侧 subject 派生在 archived-ancestor 场景下的键一致性 db 测。
//
// 不变量 #4 的本意：family delta 应在门过后在「写/θ̂ 单题路径」与「candidate-signals 批量选题
// 路径」两侧一致生效。两侧 subject 派生必须对 archived 祖先收敛到同一 family_key——
// 写/θ̂ 走 resolveFamilyKeyForQuestion → getEffectiveDomain（archived-INCLUSIVE，点查爬过 archived
// 祖先取其 domain），批量走 batchResolveFamilyKeys 内存 walk。此前批量 walk 只 load
// `archived_at IS NULL`，遇 archived 祖先即停 → 'unknown' 段，与单题路径漂移。本测坐实修复后两侧
// 对「有效 domain 经 archived 中间祖先解析」的 KC 解出**同一** family_key。YUK-722 进一步锁住
// MAX_DEPTH 边界，避免批量读侧越过单题写侧的 32-node cap。

import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import { batchResolveFamilyKeys, resolveFamilyKeyForQuestion } from './family-key';

async function insertNode(opts: {
  id: string;
  domain: string | null;
  parentId: string | null;
  archived: boolean;
}) {
  const now = new Date();
  await db.insert(knowledge).values({
    id: opts.id,
    name: `K-${opts.id}`,
    domain: opts.domain,
    parent_id: opts.parentId,
    archived_at: opts.archived ? now : null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function insertLinearChain(prefix: string, length: number, rootDomain: string) {
  const now = new Date();
  const rows = [];
  for (let i = length - 1; i >= 0; i--) {
    const isRoot = i === length - 1;
    rows.push({
      id: `${prefix}_${i}`,
      name: `${prefix}_${i}`,
      domain: isRoot ? rootDomain : null,
      parent_id: isRoot ? null : `${prefix}_${i + 1}`,
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
  await db.insert(knowledge).values(rows);
  return `${prefix}_0`;
}

describe('family-key — single/batch effective-domain parity', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('single-question (write/θ̂) and batch (selection) resolve to the SAME family_key when the effective domain comes from an archived ancestor', async () => {
    // 树：root(yuwen, archived) ← child(domain=null, active)。child 的有效 domain 经 archived
    // 祖先 root 解析为 yuwen。
    const rootId = newId();
    const childId = newId();
    await insertNode({ id: rootId, domain: 'yuwen', parentId: null, archived: true });
    await insertNode({ id: childId, domain: null, parentId: rootId, archived: false });

    const input = { primaryKnowledgeId: childId, kind: 'short_answer', source: 'manual' };

    // 写/θ̂ 单题路径（getEffectiveDomain，archived-inclusive）。
    const singleKey = await resolveFamilyKeyForQuestion(db, input);

    // candidate-signals 批量选题路径（内存 walk，archived-inclusive 后）。
    const batch = await batchResolveFamilyKeys(db, [{ questionId: 'q1', ...input }]);
    const batchKey = batch.get('q1');

    expect(singleKey).toBe(`yuwen:${childId}:short_answer:manual`);
    expect(batchKey).toBe(singleKey);
  });

  it('a genuine orphan (id absent from the tree) resolves to the unknown segment on BOTH paths', async () => {
    const orphanId = newId();
    const input = { primaryKnowledgeId: orphanId, kind: 'short_answer', source: 'manual' };

    const singleKey = await resolveFamilyKeyForQuestion(db, input);
    const batch = await batchResolveFamilyKeys(db, [{ questionId: 'q1', ...input }]);

    expect(singleKey).toBe(`unknown:${orphanId}:short_answer:manual`);
    expect(batch.get('q1')).toBe(singleKey);
  });

  it('matches the single path at and beyond the 32-node effective-domain cap', async () => {
    const atCapId = await insertLinearChain('family_at_cap', 32, 'yuwen');
    const beyondCapId = await insertLinearChain('family_beyond_cap', 33, 'yuwen');
    const common = { kind: 'short_answer', source: 'manual' };

    const atCapSingle = await resolveFamilyKeyForQuestion(db, {
      primaryKnowledgeId: atCapId,
      ...common,
    });
    const beyondCapSingle = await resolveFamilyKeyForQuestion(db, {
      primaryKnowledgeId: beyondCapId,
      ...common,
    });
    const batch = await batchResolveFamilyKeys(db, [
      { questionId: 'at-cap', primaryKnowledgeId: atCapId, ...common },
      { questionId: 'beyond-cap', primaryKnowledgeId: beyondCapId, ...common },
    ]);

    expect(atCapSingle).toBe(`yuwen:${atCapId}:short_answer:manual`);
    expect(batch.get('at-cap')).toBe(atCapSingle);
    expect(beyondCapSingle).toBe(`unknown:${beyondCapId}:short_answer:manual`);
    expect(batch.get('beyond-cap')).toBe(beyondCapSingle);
  });
});
