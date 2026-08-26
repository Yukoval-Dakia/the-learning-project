export interface DiagnosticSummary {
  errors: number;
  warnings: number;
  infos: number;
  byRule: Record<string, Partial<Record<'error' | 'warning' | 'info', number>>>;
}

export interface RatchetRegression {
  severity: 'error' | 'warning' | 'info';
  baseline: number;
  current: number;
}

export interface RatchetVerdict {
  ok: boolean;
  staleBy: Partial<Record<'errors' | 'warnings' | 'infos', number>>;
  regressions: RatchetRegression[];
}

export interface RuleDelta {
  category: string;
  severity: string;
  baseline: number;
  current: number;
  delta: number;
}

export interface LintBaselineDocument {
  schemaVersion: 1;
  channel: string;
  infoPolicy: string;
  totals: { errors: number; warnings: number; infos: number };
  byRule: Record<string, Partial<Record<'error' | 'warning' | 'info', number>>>;
}

export function summarizeDiagnostics(
  diagnostics: Array<{
    severity?: string;
    category?: string;
  }>,
): DiagnosticSummary;

export function evaluateRatchet(
  current: DiagnosticSummary,
  baseline: LintBaselineDocument,
): RatchetVerdict;

export function ruleDeltas(current: DiagnosticSummary, baseline: LintBaselineDocument): RuleDelta[];

export function buildBaselineDocument(summary: DiagnosticSummary): LintBaselineDocument;
