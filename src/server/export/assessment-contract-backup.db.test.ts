// YUK-1044 (PR #1466 CI 修复) — 评估契约真相源九表的 backup/restore 回路。
//
// 两个被测不变量：
//   1. 反向 lockstep：九表全部入 FK_ORDER（SCHEMA_VERSION 4.21），buildBackupArchive
//      的 payload 覆盖它们 —— 否则 archive.ts 模块加载即抛（reverse_lockstep 守卫）。
//   2. restore wipe 不被不可变 guard 自锁（Failure B）：restore 在
//      SET LOCAL app.assessment_restore_mode = 'on' 的单事务内 wipe+重插；
//      普通事务里 guard 照常拒绝 UPDATE/DELETE（回归用例）。
// 另验：mapping supersedes 自 FK（DEFERRABLE）在 dump 行序下 restore 不违约。

import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';
import { buildBackupArchive, restoreFromArchive } from './archive';

async function seedContractRows(): Promise<void> {
  const db = testDb();
  // question_revision（父表；rev2 supersedes rev1）
  await db.execute(sql`
    INSERT INTO question_revision (
      revision_id, group_id, revision_ordinal, integrity_digest,
      structure, response_spec, scoring_basis, execution_plan,
      supersedes_revision_id, availability, published_at
    ) VALUES
      ('rev_bk1', 'grp_bk', 1, 'sha256:bk1',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       NULL, 'general_pool', now()),
      ('rev_bk2', 'grp_bk', 2, 'sha256:bk2',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       'rev_bk1', 'general_pool', now())
  `);
  await db.execute(sql`
    INSERT INTO question_group_lifecycle (
      group_id, current_revision_id, availability, scoring_admission_state,
      scoring_admission_evidence, scoring_admission_decided_at,
      scoring_admission_generation, claim_policy, created_at, updated_at
    ) VALUES ('grp_bk', 'rev_bk2', 'general_pool', 'admitted',
              '{}'::jsonb, now(), 1, 'unbounded', now(), now())
  `);
  await db.execute(sql`
    INSERT INTO question_admission_verification (
      id, revision_id, revision_digest, policy_id, generation, outcome, recorded_at
    ) VALUES ('v_bk1', 'rev_bk1', 'sha256:bk1', 'admission-policy@2026-09-24', 0, 'passed', now())
  `);
  await db.execute(sql`
    INSERT INTO assessment_issuance (
      issuance_id, revision_id, part_ids, material_bindings, option_order,
      claim_policy, claim_status, issued_at
    ) VALUES ('iss_bk1', 'rev_bk2', '["p1"]'::jsonb, '[]'::jsonb, '[]'::jsonb,
              'unbounded', 'unclaimed', now())
  `);
  await db.execute(sql`
    INSERT INTO evaluation_group (evaluation_group_id, submission_ids, created_at)
    VALUES ('eg_bk', '["sub_bk1"]'::jsonb, now())
  `);
  await db.execute(sql`
    INSERT INTO assessment_submission (
      submission_id, issuance_id, revision_id, evaluation_group_id,
      response_set, idempotency_key, submitted_at
    ) VALUES ('sub_bk1', 'iss_bk1', 'rev_bk2', 'eg_bk',
              '{"entries":[]}'::jsonb, 'idem-bk1', now())
  `);
  await db.execute(sql`
    INSERT INTO evaluation (
      evaluation_id, evaluation_group_id, submission_id, attempt, status, created_at
    ) VALUES ('ev_bk1', 'eg_bk', 'sub_bk1', 1, 'completed', now())
  `);
  await db.execute(sql`
    INSERT INTO evaluation_effective_head (
      evaluation_group_id, submission_id, effective_evaluation_id, generation, updated_at
    ) VALUES ('eg_bk', 'sub_bk1', 'ev_bk1', 1, now())
  `);
  // mapping：修正链（map_bk2 supersedes map_bk1；同 locator 仅一条 current）。
  await db.execute(sql`
    INSERT INTO assessment_identity_mapping (
      mapping_id, source_kind, source_id, source_locator, original_question_id,
      target_revision_id, algorithm_version, status, supersedes_mapping_id,
      is_current, created_at
    ) VALUES
      ('map_bk1', 'paper_answer', 'pa_bk', 'paper.pt-slots[7]', 'q_bk',
       'rev_bk1', 'map-v1', 'mapped', NULL, false, now()),
      ('map_bk2', 'paper_answer', 'pa_bk', 'paper.pt-slots[7]', 'q_bk',
       'rev_bk2', 'map-v1', 'mapped', 'map_bk1', true, now())
  `);
}

describe('assessment contract truth-source backup round-trip (YUK-1044)', () => {
  beforeEach(resetDb);
  afterAll(resetDb);

  it('seeds → backup → restore: all 9 tables survive and the wipe phase does not hit P0001', async () => {
    const db = testDb();
    await seedContractRows();

    const { stream } = await buildBackupArchive({
      db,
      r2: memR2(),
      includeAssets: false,
    });
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);

    // Restore 在单事务内 wipe 全部 FK_ORDER 表（含四张不可变表）再正序重插 ——
    // SET LOCAL restore 通道放行 wipe，映射自 FK 延迟到 commit。
    const restored = await restoreFromArchive({ db, r2: memR2(), bytes });
    expect(restored.status).toBe(200);

    const counts = await db.execute<{
      question_revision: string;
      question_group_lifecycle: string;
      question_admission_verification: string;
      assessment_issuance: string;
      evaluation_group: string;
      assessment_submission: string;
      evaluation: string;
      evaluation_effective_head: string;
      assessment_identity_mapping: string;
    }>(sql`
      SELECT
        (SELECT count(*) FROM question_revision) AS question_revision,
        (SELECT count(*) FROM question_group_lifecycle) AS question_group_lifecycle,
        (SELECT count(*) FROM question_admission_verification) AS question_admission_verification,
        (SELECT count(*) FROM assessment_issuance) AS assessment_issuance,
        (SELECT count(*) FROM evaluation_group) AS evaluation_group,
        (SELECT count(*) FROM assessment_submission) AS assessment_submission,
        (SELECT count(*) FROM evaluation) AS evaluation,
        (SELECT count(*) FROM evaluation_effective_head) AS evaluation_effective_head,
        (SELECT count(*) FROM assessment_identity_mapping) AS assessment_identity_mapping
    `);
    expect(counts[0]).toEqual({
      question_revision: '2',
      question_group_lifecycle: '1',
      question_admission_verification: '1',
      assessment_issuance: '1',
      evaluation_group: '1',
      assessment_submission: '1',
      evaluation: '1',
      evaluation_effective_head: '1',
      assessment_identity_mapping: '2',
    });

    // 内容抽查：head 三坐标 + 修正链（选择位与裁决原样）。
    const head = await db.execute<{ effective_evaluation_id: string; generation: number }>(sql`
      SELECT effective_evaluation_id, generation FROM evaluation_effective_head
      WHERE evaluation_group_id = 'eg_bk'
    `);
    expect(head[0]).toMatchObject({ effective_evaluation_id: 'ev_bk1', generation: 1 });
    const chain = await db.execute<{
      mapping_id: string;
      status: string;
      is_current: boolean;
      supersedes_mapping_id: string | null;
    }>(sql`
      SELECT mapping_id, status, is_current, supersedes_mapping_id
      FROM assessment_identity_mapping ORDER BY mapping_id
    `);
    expect(chain).toEqual([
      { mapping_id: 'map_bk1', status: 'mapped', is_current: false, supersedes_mapping_id: null },
      {
        mapping_id: 'map_bk2',
        status: 'mapped',
        is_current: true,
        supersedes_mapping_id: 'map_bk1',
      },
    ]);
  });

  it('outside restore mode the immutability guards still reject UPDATE/DELETE (regression)', async () => {
    const db = testDb();
    await seedContractRows();

    await expect(
      db.execute(sql`UPDATE question_revision SET integrity_digest = 'rewritten'`),
    ).rejects.toMatchObject({ cause: { code: 'P0001' } });
    await expect(db.execute(sql`DELETE FROM assessment_submission`)).rejects.toMatchObject({
      cause: { code: 'P0001' },
    });
    await expect(
      db.execute(sql`UPDATE question_admission_verification SET outcome = 'failed'`),
    ).rejects.toMatchObject({ cause: { code: 'P0001' } });
    await expect(
      db.execute(sql`UPDATE assessment_issuance SET claim_policy = 'one_time'`),
    ).rejects.toMatchObject({ cause: { code: 'P0001' } });
    await expect(db.execute(sql`DELETE FROM assessment_issuance`)).rejects.toMatchObject({
      cause: { code: 'P0001' },
    });
    // claim 生命周期列在恢复模式之外仍可变。
    await db.execute(
      sql`UPDATE assessment_issuance SET claim_status = 'claimed', claimed_by_ref = 'session:t'`,
    );
    const claim = await db.execute<{ claim_status: string }>(
      sql`SELECT claim_status FROM assessment_issuance WHERE issuance_id = 'iss_bk1'`,
    );
    expect(claim[0].claim_status).toBe('claimed');
  });
});
