export const SHADOW_SENTINEL_TESTS: string[];

export interface UnitShadowSelection {
  schema_version: 1;
  requested_mode: 'skip' | 'affected' | 'full';
  effective_mode: 'affected' | 'full';
  fallback_reason?: string;
  base: string;
  changed_files: string[];
  predicted_files: string[] | null;
  unit_inventory_files?: number;
  source_scanning_unit_tests?: string[];
  direct_changed_unit_tests?: string[];
  direct_changed_tests_missed?: string[];
  selector_duration_ms?: number;
}

export interface VitestJsonResult {
  success: boolean;
  testResults: Array<{ name: string; status: string }>;
}

export interface UnitShadowReport {
  schema_version: 1;
  status: 'ok' | 'fallback' | 'warning';
  requested_mode: UnitShadowSelection['requested_mode'];
  effective_mode: UnitShadowSelection['effective_mode'];
  fallback_reason?: string;
  base: string;
  selector_duration_ms?: number;
  full_success: boolean;
  changed_files: string[];
  full_files: number;
  selected_files: number;
  selection_ratio: number;
  failed_files: string[];
  missed_failures: string[];
  changed_tests_missed: string[];
  predicted_not_in_full: string[];
  selected_file_list: string[];
  github?: {
    run_id?: string;
    run_attempt?: string;
    sha?: string;
    ref?: string;
    event_name?: string;
  };
  created_at?: string;
}

export function mergePredictedFiles(
  entries: Array<string | { file?: string }>,
  root: string,
  additionalFiles?: string[],
): string[];

export function findSourceScanningUnitTests(input: {
  unitFiles: string[];
  root: string;
}): string[];

export function resolveRequiredUnitFiles(selection?: UnitShadowSelection): string[] | null;

export function findDirectChangedUnitTestMisses(input: {
  changedFiles: string[];
  predictedFiles: string[];
  unitFiles: string[];
}): { directChangedUnitTests: string[]; misses: string[] };

export function buildShadowReport(input: {
  root: string;
  selection: UnitShadowSelection;
  fullResults: VitestJsonResult;
}): UnitShadowReport;
