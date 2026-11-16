// 卷估时（YUK-1633）：scheduling owner 对「一张卷要花多久」的唯一口径。
// 纸卷天然混合 subject/kind，没有合法单 scope 可读——pace 取 owner 现存的
// 未限定 scope 全量读（observed 样本口径不变：14 天 / 近 200 次 / 中位数 /
// <5 个可用样本回落默认 2 分钟），不猜 profile、不跨 scope 聚合。
// 定价沿用 stream-budget 的既有 paper 公式（slots × question_minutes），
// UI 不得另立系数（PfShelf 旧的 1.5 分钟/题就地删除）。

import type { Db, Tx } from '@/db/client';
import {
  installPaperTimeEstimateReader,
  type PaperTimeEstimate,
} from '@/kernel/read-models/paper-time-estimate';

import { readQuestionPace } from './question-pace';
import { estimateStreamItemMinutes } from './stream-budget';

type DbLike = Db | Tx;

export async function readPaperTimeEstimates(
  db: DbLike,
  slotCounts: readonly number[],
): Promise<PaperTimeEstimate[]> {
  const pace = await readQuestionPace(db);
  return slotCounts.map((count) => ({
    minutes: estimateStreamItemMinutes('paper', pace.minutes, count),
    source: pace.source,
    sample_count: pace.sample_count,
  }));
}

/** Host 阶段接线：把本 owner 的实现装进 kernel 读口（见 daily-review-plan 先例）。 */
export function installPaperTimeEstimateFacts(): void {
  installPaperTimeEstimateReader(readPaperTimeEstimates);
}
