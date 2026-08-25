import type { Violation } from './green-bridge-pins.mjs';

export type { Violation } from './green-bridge-pins.mjs';

export declare const EXPECTED_SCENARIOS: 13;

export type ScenarioStats = {
  total: number;
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
  ok?: boolean;
};

export type PlaywrightReport = {
  stats?: unknown;
  [key: string]: unknown;
};

export function validateChromiumProbe(probe: unknown): Violation[];

export function parsePlaywrightReport(text: string | null): {
  report: PlaywrightReport | null;
  violations: Violation[];
};

export function scenarioStats(report: PlaywrightReport | null): Partial<ScenarioStats> | null;

export function validateScenarioStats(stats: Partial<ScenarioStats> | null): Violation[];
