/** Binds the operations Agency owns behind kernel ports that other capabilities
 * call. Hosts invoke before serving or mounting job handlers. */
export async function installAgencyHostOperations(): Promise<void> {
  const [{ installLearnerContextLoader }, { loadLearnerContext }] = await Promise.all([
    import('@/kernel/read-models/learner-context'),
    import('../context/index'),
  ]);
  installLearnerContextLoader(loadLearnerContext);
}
