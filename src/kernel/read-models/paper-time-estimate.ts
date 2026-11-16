// 纸卷估时的 kernel 读口（YUK-1633）。
// 估时语义归 practice 的 scheduling owner（pace 样本口径 + paper 定价公式都在
// 那里）；消费方 session 不能向上 import scheduling（practice-subowners 只许
// 向下经目标 public.ts），所以实现经 host-operation 端口安装，组合根
// practice/public.ts 在 host 阶段接线。
// 未安装（未跑 installPracticeHost 的读面）返回 null = unknown，调用方如实
// 透传 null，绝不拿本地公式兜底。

import type { Db, Tx } from '@/db/client';
import { installHostOperation, installedHostOperation } from '@/kernel/host-operation';

type DbLike = Db | Tx;

export interface PaperTimeEstimate {
  /** 估时分钟数；0 = 卷无可作答 slot，如实给 0。 */
  minutes: number;
  /** pace 来源：observed = 学习者实测中位数；default = 样本不足回落默认。 */
  source: 'observed' | 'default';
  /** 参与中位数的有效样本数。 */
  sample_count: number;
}

/**
 * 一页卷的批量估时：实现方必须只读一次 pace，再对每个 slot 数套同一公式
 * （不 per-row N+1）。空 counts 返回空数组。
 */
export type ReadPaperTimeEstimates = (
  db: DbLike,
  slotCounts: readonly number[],
) => Promise<PaperTimeEstimate[]>;

const SLOT = 'kernel/read-models/paper-time-estimate:reader';

/** Owner 专用安装口：scheduling 在 host 阶段把实现装进来。 */
export function installPaperTimeEstimateReader(reader: ReadPaperTimeEstimates): void {
  installHostOperation(SLOT, reader);
}

/** 消费读口。未安装返回 null（unknown），调用方如实透传 null，不兜底、不重算。 */
export async function readPaperTimeEstimates(
  db: DbLike,
  slotCounts: readonly number[],
): Promise<PaperTimeEstimate[] | null> {
  const reader = installedHostOperation<ReadPaperTimeEstimates>(SLOT);
  if (!reader) return null;
  return reader(db, slotCounts);
}
