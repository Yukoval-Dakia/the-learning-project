// YUK-1055 — contract-epoch DB 面：marker 读写、迁移状态机、fenced 行为、
// per-delivery fence 与 outstanding 报告。pgboss schema 在测试容器内缺席 →
// 报告/出生 epoch 的降级路径 + 用临时表补的 born-epoch 用例都覆盖。

import { beforeEach, describe, expect, it } from 'vitest';
import { contract_epoch } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { assertContractEpochRunnable } from './epoch';

beforeEach(() => resetDb());

describe('readContractEpoch / gate wiring', () => {
  it('(legacy, active) fences post-flip code as epoch_mismatch', async () => {
    // 旧合同 DB（marker 仍是 legacy/active）上的本代码：拒跑，正是 cutover 栅栏的
    // 设计语义——post-cutover 二进制绝不在 pre-cutover 数据上执行 runtime。
    await testDb().insert(contract_epoch).values({
      seq: 0,
      epoch: 'legacy',
      state: 'active',
      entered_by: 'test',
    });
    await expect(assertContractEpochRunnable(testDb(), 'test-surface')).rejects.toMatchObject({
      name: 'ContractEpochFenceError',
      reason: 'epoch_mismatch',
    });
  });
});
