/** Binds the operations Agency owns behind kernel ports that other capabilities
 * call. Hosts invoke before serving or mounting job handlers. */
export async function installAgencyHostOperations(): Promise<void> {
  const [
    { installLearnerContextLoader },
    { installMemoryBriefReader },
    { installLearnerEvidenceLoader },
    { loadLearnerContext },
    { readMemoryBriefNote },
    { loadLearnerEvidenceBlocks },
  ] = await Promise.all([
    import('@/kernel/read-models/learner-context'),
    import('@/kernel/read-models/memory-brief'),
    import('@/kernel/read-models/learner-evidence'),
    import('../context/index'),
    import('../context/memory-brief'),
    import('./conjecture/learner-evidence'),
  ]);
  installLearnerContextLoader(loadLearnerContext);
  installMemoryBriefReader(readMemoryBriefNote);
  installLearnerEvidenceLoader(loadLearnerEvidenceBlocks);
}
