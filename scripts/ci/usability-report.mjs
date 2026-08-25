import { violation } from './green-bridge-pins.mjs';

// The shipped-container usability suite (tests/usability/shipped-container.spec.ts).
// usability-lane.test.ts keeps this count in lockstep with the spec file itself.
export const EXPECTED_SCENARIOS = 13;

const COUNTERS = ['total', 'expected', 'unexpected', 'flaky', 'skipped'];

export function validateChromiumProbe(probe) {
  if (probe === null || probe === undefined) {
    return [
      violation(
        'chromium-probe-missing',
        'the Chromium probe record is absent; a green job exit does not prove a browser launch',
      ),
    ];
  }
  if (
    typeof probe !== 'object' ||
    probe.schema_version !== 1 ||
    probe.browser !== 'chromium' ||
    typeof probe.launched !== 'boolean' ||
    typeof probe.headless !== 'boolean'
  ) {
    return [
      violation(
        'chromium-probe-malformed',
        'the Chromium probe record must carry schema_version=1, browser=chromium, boolean launched/headless',
      ),
    ];
  }
  if (!probe.launched) {
    return [
      violation(
        'chromium-launch-failed',
        `Chromium never launched on the runner image: ${probe.error ?? 'no error recorded'}`,
        'launched=true',
        'launched=false',
      ),
    ];
  }
  if (typeof probe.version !== 'string' || probe.version === '') {
    return [
      violation(
        'chromium-version-unproven',
        'a launched probe must record the browser version it actually launched',
      ),
    ];
  }
  return [];
}

export function parsePlaywrightReport(text) {
  if (typeof text !== 'string') {
    return {
      report: null,
      violations: [violation('report-json-malformed', 'the Playwright JSON report is absent')],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      report: null,
      violations: [
        violation(
          'report-json-malformed',
          `Playwright JSON report is not parsable: ${error.message}`,
        ),
      ],
    };
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed.stats === null ||
    typeof parsed.stats !== 'object'
  ) {
    return {
      report: null,
      violations: [
        violation(
          'report-json-malformed',
          'the Playwright JSON report must be an object with a stats block',
        ),
      ],
    };
  }
  return { report: parsed, violations: [] };
}

// PW 1.62.1 JSON report stats carry only the four outcome counters
// (+startTime/duration); total is derived, and `ok` is absent unless set.
export function scenarioStats(report) {
  const stats = report?.stats;
  if (stats === null || typeof stats !== 'object') return null;
  const projected = {};
  for (const key of COUNTERS) projected[key] = stats[key];
  if (projected.total === undefined) {
    projected.total =
      Number.isInteger(projected.expected) &&
      Number.isInteger(projected.skipped) &&
      Number.isInteger(projected.unexpected) &&
      Number.isInteger(projected.flaky)
        ? projected.expected + projected.skipped + projected.unexpected + projected.flaky
        : Number.NaN;
  }
  if (stats.ok !== undefined) projected.ok = stats.ok;
  return projected;
}

export function validateScenarioStats(stats) {
  if (stats === null || typeof stats !== 'object') {
    return [
      violation(
        'report-stats-malformed',
        'the Playwright report has no usable stats block; the exit status alone proves nothing',
      ),
    ];
  }
  if (!COUNTERS.every((key) => Number.isInteger(stats[key]) && stats[key] >= 0)) {
    return [
      violation(
        'report-stats-malformed',
        `scenario counters must be non-negative integers: ${JSON.stringify(stats)}`,
      ),
    ];
  }
  const violations = [];
  if (stats.total !== EXPECTED_SCENARIOS) {
    violations.push(
      violation(
        'scenario-count',
        `expected exactly ${EXPECTED_SCENARIOS} executed scenarios`,
        String(EXPECTED_SCENARIOS),
        String(stats.total),
      ),
    );
  }
  if (stats.skipped > 0) {
    violations.push(
      violation(
        'scenario-skipped',
        `${stats.skipped} scenario(s) were skipped`,
        '0 skipped',
        String(stats.skipped),
      ),
    );
  }
  if (stats.unexpected > 0) {
    violations.push(
      violation(
        'scenario-failed',
        `${stats.unexpected} scenario(s) failed`,
        '0 failed',
        String(stats.unexpected),
      ),
    );
  }
  if (stats.flaky > 0) {
    violations.push(
      violation(
        'scenario-flaky',
        `${stats.flaky} scenario(s) passed only after retry`,
        '0 flaky',
        String(stats.flaky),
      ),
    );
  }
  if (stats.ok === false) {
    violations.push(violation('report-not-ok', 'the Playwright run reported ok=false'));
  } else if (stats.ok !== undefined && stats.ok !== true) {
    violations.push(violation('report-stats-malformed', 'stats.ok must be a boolean when present'));
  }
  return violations;
}
