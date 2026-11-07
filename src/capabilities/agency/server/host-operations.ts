/** Binds the operations Agency owns behind kernel ports that other capabilities
 * call. Hosts invoke before serving or mounting job handlers. */
export async function installAgencyHostOperations(): Promise<void> {
  const [
    { installLearnerContextLoader },
    { installMemoryBriefReader },
    { installCuratorEvidenceScope },
    { loadLearnerContext },
    { readMemoryBriefNote },
    { curatorEvidenceScope },
  ] = await Promise.all([
    import('@/kernel/read-models/learner-context'),
    import('@/kernel/read-models/memory-brief'),
    import('@/kernel/read-models/curator-evidence-scope'),
    import('../context/index'),
    import('../context/memory-brief'),
    import('../context/curator-evidence'),
  ]);
  installLearnerContextLoader(loadLearnerContext);
  installMemoryBriefReader(readMemoryBriefNote);
  installCuratorEvidenceScope(curatorEvidenceScope);
}
