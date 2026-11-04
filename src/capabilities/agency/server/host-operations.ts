/** Binds the operations Agency owns behind kernel ports that other capabilities
 * call. Hosts invoke before serving or mounting job handlers. */
export async function installAgencyHostOperations(): Promise<void> {
  const [
    { installLearnerContextLoader },
    { installMemoryBriefReader },
    { loadLearnerContext },
    { readMemoryBriefNote },
  ] = await Promise.all([
    import('@/kernel/read-models/learner-context'),
    import('@/kernel/read-models/memory-brief'),
    import('../context/index'),
    import('../context/memory-brief'),
  ]);
  installLearnerContextLoader(loadLearnerContext);
  installMemoryBriefReader(readMemoryBriefNote);
}
