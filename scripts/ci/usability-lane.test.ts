import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMAGE_STATE_PENDING, IMAGE_STATE_PUBLISHED, validatePins } from './green-bridge-pins.mjs';
import { buildManifest, validateManifest } from './usability-lane.mjs';
import {
  EXPECTED_SCENARIOS,
  parsePlaywrightReport,
  scenarioStats,
  validateChromiumProbe,
  validateScenarioStats,
} from './usability-report.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'9'.repeat(64)}`;
const PUBLISHED_IMAGE_DIGEST =
  'sha256:7c78040230e6b50fcc355ec1bb562ac566ceb4f1dbfcb90a525e4e01af68139d';

const PROBE_OK = {
  schema_version: 1,
  launched: true,
  browser: 'chromium',
  version: '140.0.7339.14',
  headless: true,
  error: null,
};

const PROBE_LIBNSPR4 = {
  schema_version: 1,
  launched: false,
  browser: 'chromium',
  version: null,
  headless: true,
  error:
    'browserType.launch: Host system is missing dependencies to run browsers. Missing libraries: libnspr4.so',
};

type StatsShape = {
  total: number;
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
  ok: boolean;
};

function statsFixture({
  expected = EXPECTED_SCENARIOS,
  unexpected = 0,
  flaky = 0,
  skipped = 0,
  ok,
}: Omit<Partial<StatsShape>, 'total'> = {}): StatsShape {
  return {
    total: expected + skipped + unexpected + flaky,
    expected,
    unexpected,
    flaky,
    skipped,
    ...(ok === undefined ? {} : { ok }),
  } as StatsShape;
}

function reportFixture(stats: StatsShape, version = '1.62.1') {
  // Real PW 1.62.1 JSON reports carry only the four outcome counters - no
  // total, no ok (verified against a live run on 2026-08-25).
  const { total: _total, ok: _ok, ...counters } = stats;
  return JSON.stringify({
    config: { version },
    suites: [],
    errors: [],
    stats: { startTime: '2026-08-25T00:00:00.000Z', duration: 90_000, ...counters },
  });
}

function pinsFixture({
  state = IMAGE_STATE_PENDING,
  digest = '',
  publishedAt = '',
}: {
  state?: string;
  digest?: string;
  publishedAt?: string;
} = {}) {
  const lines = [
    '# YUK-917 runner lane pins fixture.',
    'GITHUB_ACTIONS_PLUGIN_SOURCE=buildkite-plugins/github-actions-buildkite-plugin',
    'GITHUB_ACTIONS_PLUGIN_RELEASE=v0.13.0',
    `GITHUB_ACTIONS_PLUGIN_COMMIT=${SHA}`,
    'GITHUB_ACTIONS_PLUGIN_OBSERVED_AT=2026-08-25',
    'NODE_VERSION=24.0.0',
    'PNPM_VERSION=11.13.1',
    'BUN_VERSION=1.3.14',
    'PIN_MAX_AGE_DAYS=30',
    'CI_IMAGE_REPO=ghcr.io/yukoval-dakia/the-learning-project/buildkite-ci',
    'CI_IMAGE_BASE_REF=mcr.microsoft.com/playwright:v1.62.1-noble',
    `CI_IMAGE_BASE_DIGEST=${DIGEST}`,
    'CI_IMAGE_PLAYWRIGHT_VERSION=1.62.1',
    `CI_IMAGE_STATE=${state}`,
  ];
  if (digest !== '') lines.push(`CI_IMAGE_DIGEST=${digest}`);
  if (publishedAt !== '') lines.push(`CI_IMAGE_PUBLISHED_AT=${publishedAt}`);
  return lines.join('\n');
}

const NOW = new Date('2026-08-30T00:00:00Z');

function codes(violations: { code: string }[]): string[] {
  return violations.map((entry) => entry.code);
}

describe('usability lane chromium probe', () => {
  it('accepts a probe that proves headless Chromium launched with a version', () => {
    expect(validateChromiumProbe(PROBE_OK)).toEqual([]);
  });

  it('fails when Chromium never launched (the libnspr4.so regression class)', () => {
    const violations = validateChromiumProbe(PROBE_LIBNSPR4);
    expect(codes(violations)).toContain('chromium-launch-failed');
    const manifest = buildManifest({
      probe: PROBE_LIBNSPR4,
      reportText: reportFixture(statsFixture()),
      pinsText: pinsFixture(),
      env: {},
      now: NOW,
    });
    expect(manifest.status).toBe('failed');
    expect(manifest.cutover_ready).toBe(false);
  });

  it('fails when the probe record is absent entirely', () => {
    expect(codes(validateChromiumProbe(null))).toContain('chromium-probe-missing');
    expect(codes(validateChromiumProbe({ launched: true }))).toContain('chromium-probe-malformed');
  });
});

describe('usability lane scenario gate', () => {
  it('accepts exactly 13 passed scenarios', () => {
    expect(validateScenarioStats(statsFixture())).toEqual([]);
  });

  it('fails when the executed count differs from 13', () => {
    const violations = validateScenarioStats(statsFixture({ expected: 12 }));
    expect(codes(violations)).toContain('scenario-count');
  });

  it('fails when any scenario is skipped, failed, or flaky', () => {
    const skipped = validateScenarioStats(statsFixture({ expected: 12, skipped: 1 }));
    expect(codes(skipped)).toContain('scenario-skipped');

    const failed = validateScenarioStats(statsFixture({ expected: 12, unexpected: 1 }));
    expect(codes(failed)).toContain('scenario-failed');

    const flaky = validateScenarioStats(statsFixture({ expected: 12, flaky: 1 }));
    expect(codes(flaky)).toContain('scenario-flaky');
  });

  it('fails when the report is malformed or the stats block is unusable', () => {
    expect(codes(parsePlaywrightReport('{nope').violations).length).toBeGreaterThan(0);
    const empty = parsePlaywrightReport('{}');
    expect(empty.report).toBeNull();
    expect(codes(validateScenarioStats(scenarioStats(empty.report)))).toContain(
      'report-stats-malformed',
    );
    expect(codes(validateScenarioStats(statsFixture({ expected: Number.NaN })))).toContain(
      'report-stats-malformed',
    );
    expect(codes(validateScenarioStats(statsFixture({ ok: false })))).toContain('report-not-ok');
  });

  it('derives the executed total from the real PW counters shape', () => {
    const parsed = parsePlaywrightReport(
      JSON.stringify({
        stats: {
          startTime: '2026-08-25T00:00:00.000Z',
          duration: 1,
          expected: 13,
          skipped: 0,
          unexpected: 0,
          flaky: 0,
        },
      }),
    );
    expect(parsed.report).not.toBeNull();
    expect(scenarioStats(parsed.report)).toEqual({
      total: 13,
      expected: 13,
      skipped: 0,
      unexpected: 0,
      flaky: 0,
    });
  });
});

describe('usability lane manifest', () => {
  it('builds an ok manifest that stays cutover-blocked while the image digest is pending', () => {
    const manifest = buildManifest({
      probe: PROBE_OK,
      reportText: reportFixture(statsFixture()),
      pinsText: pinsFixture(),
      env: {
        BUILDKITE: 'true',
        BUILDKITE_BUILD_NUMBER: '9',
        BUILDKITE_PIPELINE_SLUG: 'the-learning-project-ci-shadow',
        BUILDKITE_BRANCH: 'codex/yuk-916-ci-buildkite-shadow',
        BUILDKITE_COMMIT: SHA,
      },
      now: NOW,
    });
    expect(manifest.status).toBe('ok');
    expect(manifest.violations).toEqual([]);
    expect(manifest.scenarios).toEqual({ ...statsFixture(), expected_total: 13 });
    expect(manifest.chromium).toMatchObject({ launched: true, version: '140.0.7339.14' });
    expect(manifest.image).toMatchObject({ state: IMAGE_STATE_PENDING, digest: null });
    expect(manifest.cutover_ready).toBe(false);
    expect(validateManifest(manifest)).toEqual([]);
  });

  it('marks cutover_ready only after the lead commits a published digest', () => {
    const manifest = buildManifest({
      probe: PROBE_OK,
      reportText: reportFixture(statsFixture()),
      pinsText: pinsFixture({
        state: IMAGE_STATE_PUBLISHED,
        digest: DIGEST,
        publishedAt: '2026-08-29',
      }),
      env: {},
      now: NOW,
    });
    expect(manifest.status).toBe('ok');
    expect(manifest.image.state).toBe(IMAGE_STATE_PUBLISHED);
    expect(manifest.image.digest).toBe(DIGEST);
    expect(manifest.cutover_ready).toBe(true);
  });

  it('rejects an exit-code-only manifest that proves neither Chromium nor scenarios', () => {
    expect(codes(validateManifest(null))).toContain('manifest-missing');
    expect(codes(validateManifest('ok'))).toContain('manifest-malformed');
    const exitOnly = validateManifest({
      schema_version: 1,
      mode: 'usability-lane',
      status: 'ok',
      exit_code: 0,
    });
    expect(codes(exitOnly)).toContain('manifest-chromium-unproven');
    expect(codes(exitOnly)).toContain('manifest-scenarios-unproven');
  });

  it('rejects a manifest whose cutover_ready disagrees with the image state', () => {
    const manifest = buildManifest({
      probe: PROBE_OK,
      reportText: reportFixture(statsFixture()),
      pinsText: pinsFixture(),
      env: {},
      now: NOW,
    });
    const tampered = { ...manifest, cutover_ready: true };
    expect(codes(validateManifest(tampered))).toContain('manifest-cutover-inconsistent');
  });
});

describe('usability lane pins image state', () => {
  it('accepts the pending state and forbids a digest pretending to be published', () => {
    const pending = validatePins({ pinsText: pinsFixture(), now: NOW });
    expect(pending.violations).toEqual([]);
    expect(pending.pins.CI_IMAGE_STATE).toBe(IMAGE_STATE_PENDING);

    const pendingWithDigest = validatePins({
      pinsText: pinsFixture({ digest: DIGEST }),
      now: NOW,
    });
    expect(codes(pendingWithDigest.violations)).toContain('ci-image-digest-forbidden');
  });

  it('requires a real sha256 digest plus observation date once published', () => {
    const published = validatePins({
      pinsText: pinsFixture({
        state: IMAGE_STATE_PUBLISHED,
        digest: DIGEST,
        publishedAt: '2026-08-29',
      }),
      now: NOW,
    });
    expect(published.violations).toEqual([]);

    const noDigest = validatePins({
      pinsText: pinsFixture({ state: IMAGE_STATE_PUBLISHED, publishedAt: '2026-08-29' }),
      now: NOW,
    });
    expect(codes(noDigest.violations)).toContain('ci-image-digest-missing');

    const bogusDigest = validatePins({
      pinsText: pinsFixture({
        state: IMAGE_STATE_PUBLISHED,
        digest: 'sha256:latest',
        publishedAt: '2026-08-29',
      }),
      now: NOW,
    });
    expect(codes(bogusDigest.violations)).toContain('ci-image-digest-malformed');
  });

  it('rejects unknown image states and stale publication observations', () => {
    const unknown = validatePins({
      pinsText: pinsFixture({ state: 'sort-of-there', digest: '', publishedAt: '' }),
      now: NOW,
    });
    expect(codes(unknown.violations)).toContain('ci-image-state-invalid');

    const stale = validatePins({
      pinsText: pinsFixture({
        state: IMAGE_STATE_PUBLISHED,
        digest: DIGEST,
        publishedAt: '2026-01-01',
      }),
      now: NOW,
    });
    expect(codes(stale.violations)).toContain('ci-image-published-stale');
  });

  it('keeps the repo pins, Dockerfile base digest, and Playwright version in lockstep', () => {
    const pins = readFileSync('.buildkite/pins.env', 'utf8');
    const parsed = validatePins({ pinsText: pins, now: NOW });
    expect(parsed.violations).toEqual([]);
    expect(parsed.pins.CI_IMAGE_STATE).toBe(IMAGE_STATE_PUBLISHED);
    expect(parsed.pins.CI_IMAGE_DIGEST).toBe(PUBLISHED_IMAGE_DIGEST);
    expect(parsed.pins.CI_IMAGE_PUBLISHED_AT).toBe('2026-08-25');

    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    expect(parsed.pins.CI_IMAGE_PLAYWRIGHT_VERSION).toBe(pkg.devDependencies['@playwright/test']);

    const dockerfile = readFileSync('.buildkite/ci-image/Dockerfile', 'utf8');
    const fromDigest = dockerfile.match(
      /^FROM mcr\.microsoft\.com\/playwright@sha256:([0-9a-f]{64})/m,
    );
    expect(fromDigest, 'Dockerfile must pin the Playwright base by full digest').not.toBeNull();
    expect(`sha256:${fromDigest?.[1]}`).toBe(parsed.pins.CI_IMAGE_BASE_DIGEST);
    expect(dockerfile).toMatch(/id pwuser/);
    const runner = readFileSync('.buildkite/scripts/run-usability-lane.sh', 'utf8');
    expect(runner).toMatch(/runuser -u "\$SERVER_USER" -- env/);
  });

  it('keeps EXPECTED_SCENARIOS in lockstep with the real spec file', () => {
    const spec = readFileSync('tests/usability/shipped-container.spec.ts', 'utf8');
    const declared = spec.match(/^\s*test\(/gm)?.length ?? 0;
    expect(declared).toBe(EXPECTED_SCENARIOS);
  });
});
