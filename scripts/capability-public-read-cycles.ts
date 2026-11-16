// Capability public-read cycle catalog.
//
// DATA FOR THE AUDIT, NOT RUNTIME LOOKUP. Each row is one intra-SCC
// cross-capability value edge. No nontrivial SCC remains; remaining rows are
// one-way edges the scanner still checks.
// scripts/audit-architecture-deepening.ts enforces:
//   - every intra-SCC edge direction and every consumer file appears here;
//   - files NOT listed in `commandFiles` contain no write signatures and
//     consume no command symbols from the port (bounded public reads);
//   - files listed in `commandFiles` are the classified command edges.

import type { PublicReadCycleEdge } from './audit-architecture-deepening';

export const publicReadCycleCatalog: readonly PublicReadCycleEdge[] = [];
