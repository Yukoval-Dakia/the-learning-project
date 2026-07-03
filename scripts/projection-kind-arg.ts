// YUK-548 (independent review K11) — the shared `--kind=<X>` CLI arg parser for the golden scripts
// (capture-golden.ts / golden-reaudit.ts). Lives scripts-side (NOT next to entity-registry): argv
// parsing + process.exit are CLI concerns, not server-library surface.

import { ALL_PROJECTION_KINDS, type ProjectionKind } from '@/server/projections/entity-registry';

/**
 * Parse the required `--kind=<X>` argv flag, validating against ALL_PROJECTION_KINDS. Exits 2 with a
 * usage message (prefixed `[<prefix>]`) when missing/invalid — CLI-only, never import from server code.
 */
export function parseKindArg(prefix: string): ProjectionKind {
  const arg = process.argv.find((a) => a.startsWith('--kind='));
  const kind = arg?.slice('--kind='.length);
  if (!kind || !(ALL_PROJECTION_KINDS as readonly string[]).includes(kind)) {
    console.error(`[${prefix}] --kind=<X> required, one of: ${ALL_PROJECTION_KINDS.join(', ')}`);
    process.exit(2);
  }
  return kind as ProjectionKind;
}
