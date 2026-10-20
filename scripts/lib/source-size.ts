/**
 * Source-size ratchet facts (architecture anti-regression, 2026-10-20 proposal
 * §1.3–§1.4). One frozen metric — same scope and counting for base and head:
 * git-tracked `src/`, `server/`, `web/` `.ts/.tsx` files, excluding
 * `.test.`/`.spec.`/`.generated.`, lines counted as LF characters.
 * - no NEW >1500-line path may appear (renames keep their base identity and do
 *   not launder stock), and the >1500 count must not grow;
 * - a file already >1000 at base that grew, a file crossing 1000, or a new
 *   >1000 file must carry a structured registration the audit can reconcile
 *   against the real diff.
 */
import { z } from 'zod';

export const SIZE_METRIC = {
  version: 1,
  roots: ['src', 'server', 'web'],
  extensions: ['.ts', '.tsx'],
  excludeSubstrings: ['.test.', '.spec.', '.generated.'],
  registrationThreshold: 1000,
  hardCeiling: 1500,
} as const;

export const ISSUE_RE = /^YUK-\d+$/;

const int = z.number().int().nonnegative();
const isoDate = z.iso.date();
const issue = z.string().regex(ISSUE_RE, 'Linear issue like YUK-1234');

export const sourceSizeRecordSchema = z.object({
  /** Head repo-relative path of the grown/new file. */
  path: z.string().trim().min(1),
  date: isoDate,
  /** Blob SHA of the base-identity file; null when the file is new. */
  baseBlob: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'base blob SHA')
    .nullable(),
  /** Base line count; null when the file is new. */
  from: int.nullable(),
  /** Measured head line count. */
  to: int,
  issue,
  responsibilityReason: z.string().trim().min(1),
});
export type SourceSizeRecord = z.infer<typeof sourceSizeRecordSchema>;

export const edgeRecordSchema = z.object({
  debt: z.enum(['capabilityToServer', 'crossCapabilityValue', 'capabilityToKernel']),
  /** Repo-relative consumer file. */
  file: z.string().trim().min(1),
  /** Resolved repo-relative target module. */
  module: z.string().trim().min(1),
  kind: z.enum(['value', 'type']),
  /** Symbols the file actually consumes from the module ('*' for namespace/bare). */
  symbols: z.array(z.string().trim().min(1)).min(1),
  issue,
  /** The complete operation/fact the consumed target owns — in the author's words. */
  owns: z.string().trim().min(1),
  date: isoDate,
});
export type EdgeRecord = z.infer<typeof edgeRecordSchema>;

const MAX_SHIM_DAYS = 14;

export const compatShimSchema = z
  .object({
    /** Repo-relative path of the shim file. */
    path: z.string().trim().min(1),
    kind: z.enum(['module', 'function', 'alias', 'site']),
    /** Exported symbol the shim covers; required for function/alias, '*' allowed for site. */
    symbol: z.string().trim().min(1).optional(),
    /** Resolved target module; required for site-kind entries. */
    targetModule: z.string().trim().min(1).optional(),
    /** Real consumer evidence: file + line of its import of this shim. */
    consumers: z
      .array(z.object({ file: z.string().trim().min(1), line: z.number().int().positive() }))
      .min(1),
    exitCondition: z.string().trim().min(1),
    issue,
    /** Traceable approval source (URL). The audit verifies presence and shape only. */
    approval: z.url({ protocol: /^https?$/ }),
    date: isoDate,
    /** Hard expiry — approvals run at most 14 days; an expired live shim fails. */
    deadline: isoDate,
  })
  .refine((shim) => shim.kind !== 'site' || shim.targetModule !== undefined, {
    message: 'site-kind shim records must name targetModule',
  });
export type CompatShim = z.infer<typeof compatShimSchema>;

/**
 * A coordinator-ruled stable public contract ruling — the only legal way a
 * new pass-through site avoids the 14-day compat window. It lives inside the
 * existing `changes` ledger (discriminated by `type`), never in debt math.
 * Binding is exact: file + site kind + exported symbol + target module +
 * target symbol, so a renamed alias, moved target or different implementation
 * owner can never inherit an old ruling.
 */
export const stableContractRulingSchema = z.object({
  type: z.literal('stable_contract'),
  /** Repo-relative path of the ruled site file (site.file identity). */
  file: z.string().trim().min(1),
  siteKind: z.enum(['module', 'function', 'alias', 'site']),
  /** Exported symbol the ruling binds — exact; '*' (export-star / namespace)
   *  is refused: a stable ruling is always a per-symbol decision, never a
   *  blanket exemption future symbols could inherit. */
  symbol: z
    .string()
    .trim()
    .min(1)
    .refine((v) => v !== '*', 'stable rulings bind one named symbol, not a namespace'),
  /** Resolved repo-relative target module the site forwards to. */
  targetModule: z.string().trim().min(1),
  /** Symbol inside targetModule that owns the complete decision — same
   *  no-namespace rule: '*' would exempt every future export of that
   *  module without a per-symbol coordinator decision. */
  targetSymbol: z
    .string()
    .trim()
    .min(1)
    .refine((v) => v !== '*', 'stable rulings bind one named target symbol, not a namespace'),
  /** Real implementation owner — must equal targetModule's capability dir. */
  owner: z.string().trim().min(1),
  /** Real consumer evidence: file + line of its import of this site file. */
  consumers: z
    .array(z.object({ file: z.string().trim().min(1), line: z.number().int().positive() }))
    .min(1),
  /** Source evidence: file:line ranges proving the target owns the decision. */
  evidence: z.string().trim().min(1),
  /** Why this is a stable public contract, not a temporary compat hand-off. */
  rationale: z.string().trim().min(1),
  issue,
  /** Traceable coordinator confirmation (URL). Shape verified; authority is review's. */
  approval: z.url({ protocol: /^https?$/ }),
  date: isoDate,
});
export type StableContractRuling = z.infer<typeof stableContractRulingSchema>;

export interface SizedFile {
  path: string;
  lines: number;
  blob: string;
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

export function collectSizeFacts(
  files: readonly { path: string; lines: number; blob?: string }[],
): { overCeiling: Map<string, number>; overThreshold: Map<string, number> } {
  const overCeiling = new Map<string, number>();
  const overThreshold = new Map<string, number>();
  for (const file of files) {
    if (file.lines > SIZE_METRIC.hardCeiling) overCeiling.set(file.path, file.lines);
    if (file.lines > SIZE_METRIC.registrationThreshold) overThreshold.set(file.path, file.lines);
  }
  return { overCeiling, overThreshold };
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Compare measured size facts against the base (rename-normalized) and validate
 * the registration tail. `records` is the head ledger, `previousRecords` the
 * base ledger's length — only the tail is required to match the live diff.
 */
export function auditSourceSizeRatchet(input: {
  base: readonly SizedFile[];
  head: readonly SizedFile[];
  renames: ReadonlyMap<string, string>;
  records: readonly SourceSizeRecord[];
  previousRecords: number;
  today: string;
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

  const tailRecords = input.records.slice(input.previousRecords);
  const usedRecords = new Set<number>();
  for (const file of input.head) {
    if (file.lines <= SIZE_METRIC.registrationThreshold) continue;
    const basePath = headToBase.get(file.path) ?? file.path;
    const baseEntry = baseByPath.get(basePath);
    const isNew = baseEntry === undefined;
    const crossed = baseEntry !== undefined && baseEntry.lines <= SIZE_METRIC.registrationThreshold;
    const grew = baseEntry !== undefined && file.lines > baseEntry.lines;
    if (!isNew && !crossed && !grew) continue;
    const recordIndex = tailRecords.findIndex(
      (record, i) => record.path === file.path && !usedRecords.has(i),
    );
    if (recordIndex === -1) {
      fail(
        file.path,
        `${baseEntry?.lines ?? 'new'} -> ${file.lines} lines`,
        `>${SIZE_METRIC.registrationThreshold}-line growth/crossing must carry a sourceSizeRecords entry {path, baseBlob, from, to, issue, responsibilityReason}`,
      );
      continue;
    }
    usedRecords.add(recordIndex);
    const record = tailRecords[recordIndex];
    if (record.to !== file.lines) {
      fail(file.path, 'sourceSizeRecords', `record.to=${record.to} != measured ${file.lines}`);
    }
    if (baseEntry) {
      if (record.from !== baseEntry.lines || record.baseBlob !== baseEntry.blob) {
        fail(
          file.path,
          'sourceSizeRecords',
          `record base identity mismatch: expected from=${baseEntry.lines} baseBlob=${baseEntry.blob}`,
        );
      }
    } else if (record.from !== null || record.baseBlob !== null) {
      fail(file.path, 'sourceSizeRecords', 'new file must record from=null and baseBlob=null');
    }
  }
  tailRecords.forEach((record, i) => {
    if (usedRecords.has(i)) return;
    fail(
      record.path,
      'sourceSizeRecords',
      'registration does not correspond to a real >1000 growth/crossing/new file in this diff',
    );
  });
  return violations;
}

export function shimIsLive(shim: CompatShim, today: string): boolean {
  return daysBetween(today, shim.deadline) >= 0;
}

/**
 * Field-level approval checks on a NEW compatShims tail entry: the record date
 * may not be post-dated (a future date would stretch the 14-day window) and
 * the deadline may not exceed date+14d, which bounds the whole window against
 * today. Consumers/site coverage live in the audit.
 */
export function validateCompatShimFields(record: CompatShim, today: string): string[] {
  const problems: string[] = [];
  if (daysBetween(today, record.date) > 0) {
    problems.push(`date ${record.date} is in the future — approval records may not be post-dated`);
  }
  if (daysBetween(record.date, record.deadline) > MAX_SHIM_DAYS) {
    problems.push(`deadline ${record.deadline} exceeds the ${MAX_SHIM_DAYS}-day approval window`);
  }
  return problems;
}

/**
 * Field-level checks on a NEW `stable_contract` ruling: the ruling date may
 * not be post-dated, and `owner` must equal the capability directory that
 * owns targetModule — the ruling must name the real implementation owner,
 * not an author-chosen label.
 */
export function validateStableRulingFields(ruling: StableContractRuling, today: string): string[] {
  const problems: string[] = [];
  if (daysBetween(today, ruling.date) > 0) {
    problems.push(`date ${ruling.date} is in the future — approval records may not be post-dated`);
  }
  if (ruling.targetModule.startsWith('src/capabilities/')) {
    const owner = ruling.targetModule.split('/')[2];
    if (owner && ruling.owner !== owner) {
      problems.push(
        `owner '${ruling.owner}' != target capability owner '${owner}' — the ruling must name the real implementation owner`,
      );
    }
  }
  return problems;
}
