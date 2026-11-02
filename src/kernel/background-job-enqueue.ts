// Test processes must not enqueue real background work. Read the environment on
// each call; this guard does not establish worker liveness or dispatch completion.
export function shouldEnqueueBackgroundJobs(): boolean {
  const isTestEnv = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
  return !isTestEnv;
}
