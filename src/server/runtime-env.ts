/**
 * Whether requests should enqueue pg-boss background jobs. Test runs are detected via
 * NODE_ENV or VITEST; this module stays DB-free so its unit test can live in the unit
 * partition.
 */
export function shouldEnqueueBackgroundJobs(): boolean {
  const isTestEnv = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
  return !isTestEnv;
}
