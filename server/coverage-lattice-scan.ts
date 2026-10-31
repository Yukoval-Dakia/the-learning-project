// Binds practice's supply scanner into the kernel coverage lattice. The lattice
// owns activity aggregation and the read shape; practice still owns the scan.

import type { Db, Tx } from '@/db/client';
import type { CoverageScanFacts } from '@/kernel/read-models/coverage-lattice';

export async function installCoverageLatticeScan(): Promise<void> {
  const [{ installCoverageScanReader }, practice] = await Promise.all([
    import('@/kernel/read-models/coverage-lattice'),
    import('@/capabilities/practice/public'),
  ]);
  installCoverageScanReader(async (db: Db | Tx): Promise<CoverageScanFacts> => {
    const started = Date.now();
    const scanInput = await practice.assembleScanInput(db);
    const assembleMs = Date.now() - started;
    return {
      frontier: scanInput.frontier,
      questions: scanInput.questions,
      targets: practice.scanCoverageGaps(scanInput),
      coverageDepthThreshold: practice.COVERAGE_DEPTH_THRESHOLD,
      nearWindow: practice.NEAR_WINDOW,
      cooldownDays: practice.SUPPLY_DISPATCH_COOLDOWN_DAYS,
      assembleMs,
    };
  });
}
