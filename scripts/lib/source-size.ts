/**
 * Source-size ratchet facts (architecture anti-regression, 2026-10-20 proposal
 * §1.3–§1.4). One frozen metric — same scope and counting for base and head:
 * git-tracked `src/`, `server/`, `web/` `.ts/.tsx` files, excluding
 * `.test.`/`.spec.`/`.generated.`, lines counted as LF characters. No NEW
 * >1500-line path may appear (renames keep their base identity and do not
 * launder stock), and the >1500 count must not grow.
 */

export const SIZE_METRIC = {
  version: 1,
  roots: ['src', 'server', 'web'],
  extensions: ['.ts', '.tsx'],
  excludeSubstrings: ['.test.', '.spec.', '.generated.'],
  hardCeiling: 1500,
} as const;

export interface SizedFile {
  path: string;
  lines: number;
}

export interface SizeViolation {
  file: string;
  source: string;
  reason: string;
}

export function inSizeScope(path: string): boolean {
  if (!SIZE_METRIC.roots.some((root) => path.startsWith(`${root}/`))) return false;
  if (!SIZE_METRIC.extensions.some((ext) => path.endsWith(ext))) return false;
  return !SIZE_METRIC.excludeSubstrings.some((needle) => path.includes(needle));
}

/** Compare measured size facts against the base (rename-normalized). */
export function auditSourceSizeRatchet(input: {
  base: readonly SizedFile[];
  head: readonly SizedFile[];
  renames: ReadonlyMap<string, string>;
}): SizeViolation[] {
  const violations: SizeViolation[] = [];
  const fail = (file: string, source: string, reason: string) =>
    violations.push({ file, source, reason });

  const headToBase = new Map<string, string>();
  for (const [basePath, headPath] of input.renames) headToBase.set(headPath, basePath);
  const baseByPath = new Map(input.base.map((entry) => [entry.path, entry]));
  const headOverCeiling = input.head.filter((f) => f.lines > SIZE_METRIC.hardCeiling);
  const baseOverCeiling = input.base.filter((f) => f.lines > SIZE_METRIC.hardCeiling);
  const baseCeilingSet = new Set(baseOverCeiling.map((f) => f.path));

  for (const file of headOverCeiling) {
    const basePath = headToBase.get(file.path) ?? file.path;
    if (!baseCeilingSet.has(basePath)) {
      const baseEntry = baseByPath.get(basePath);
      fail(
        file.path,
        `${file.lines} lines`,
        baseEntry
          ? `new >${SIZE_METRIC.hardCeiling}-line source path (base identity ${basePath} had ${baseEntry.lines} lines — a rename does not launder the budget)`
          : `new >${SIZE_METRIC.hardCeiling}-line source path with no base identity`,
      );
    }
  }
  if (headOverCeiling.length > baseOverCeiling.length) {
    fail(
      'src+server+web',
      'source-size ratchet',
      `>${SIZE_METRIC.hardCeiling}-line file count grew ${baseOverCeiling.length} -> ${headOverCeiling.length}; stock must shrink, not rotate`,
    );
  }

  return violations;
}
