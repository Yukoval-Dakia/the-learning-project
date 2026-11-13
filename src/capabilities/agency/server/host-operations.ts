/** Binds the operations Agency owns behind kernel ports that other capabilities
 * call. Hosts invoke before serving or mounting job handlers. */
export async function installAgencyHostOperations(): Promise<void> {
  const [
    { installLearnerContextLoader },
    { installMemoryBriefReader },
    { installCuratorEvidenceScope },
    { installLearnerEvidenceLoader },
    { loadLearnerContext },
    { readMemoryBriefNote },
    { curatorEvidenceScope },
    { loadLearnerEvidenceBlocks },
  ] = await Promise.all([
    import('@/kernel/read-models/learner-context'),
    import('@/kernel/read-models/memory-brief'),
    import('@/kernel/read-models/curator-evidence-scope'),
    import('@/kernel/read-models/learner-evidence'),
    import('../context/index'),
    import('../context/memory-brief'),
    import('../context/curator-evidence'),
    import('./conjecture/learner-evidence'),
  ]);
  installLearnerContextLoader(loadLearnerContext);
  installMemoryBriefReader(readMemoryBriefNote);
  installCuratorEvidenceScope(curatorEvidenceScope);
  installLearnerEvidenceLoader(loadLearnerEvidenceBlocks);
}
