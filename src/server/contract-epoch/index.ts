// YUK-1055 — contract-epoch 模块公共出口。

export type { OutstandingJobDisposition } from './boss-fence';
export { fenceAwareJobHandler, reportOutstandingBossJobs } from './boss-fence';
export * from './epoch';
export type { JobEpochDisposition } from './jobs';
export { JOB_EPOCH_DISPOSITION, jobEpochDisposition } from './jobs';
export * from './rules';
