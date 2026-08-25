import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  IMAGE_STATE_PENDING,
  IMAGE_STATE_PUBLISHED,
  validatePins,
  violation,
} from './green-bridge-pins.mjs';
import {
  EXPECTED_SCENARIOS,
  parsePlaywrightReport,
  scenarioStats,
  validateChromiumProbe,
  validateScenarioStats,
} from './usability-report.mjs';

export { EXPECTED_SCENARIOS, IMAGE_STATE_PENDING, IMAGE_STATE_PUBLISHED };

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function buildManifest({ probe, reportText, pinsText, env = {}, now = new Date() }) {
  const violations = [];
  violations.push(...validateChromiumProbe(probe));
  const parsed = parsePlaywrightReport(reportText);
  violations.push(...parsed.violations);
  const stats = scenarioStats(parsed.report);
  violations.push(...validateScenarioStats(stats));

  let pins = {};
  if (pinsText === null || pinsText === undefined) {
    violations.push(violation('pins-unreadable', 'the green-bridge pins file could not be read'));
  } else {
    const pinsResult = validatePins({ pinsText, now });
    violations.push(...pinsResult.violations);
    pins = pinsResult.pins;
  }

  const image = {
    state: pins.CI_IMAGE_STATE ?? null,
    digest: pins.CI_IMAGE_STATE === IMAGE_STATE_PUBLISHED ? (pins.CI_IMAGE_DIGEST ?? null) : null,
    base_ref: pins.CI_IMAGE_BASE_REF ?? null,
    base_digest: pins.CI_IMAGE_BASE_DIGEST ?? null,
    playwright_version: pins.CI_IMAGE_PLAYWRIGHT_VERSION ?? null,
  };
  const status = violations.length === 0 ? 'ok' : 'failed';
  const cutoverReady =
    status === 'ok' &&
    image.state === IMAGE_STATE_PUBLISHED &&
    typeof image.digest === 'string' &&
    SHA256_DIGEST.test(image.digest);

  return {
    schema_version: 1,
    mode: 'usability-lane',
    status,
    generated_at: now.toISOString(),
    build: {
      number: env.BUILDKITE_BUILD_NUMBER ?? null,
      pipeline: env.BUILDKITE_PIPELINE_SLUG ?? null,
      branch: env.BUILDKITE_BRANCH ?? null,
      commit: env.BUILDKITE_COMMIT ?? null,
    },
    chromium:
      probe !== null && typeof probe === 'object'
        ? {
            launched: typeof probe.launched === 'boolean' ? probe.launched : null,
            browser: probe.browser ?? null,
            version: probe.version ?? null,
            headless: probe.headless ?? null,
            error: probe.error ?? null,
          }
        : null,
    scenarios:
      stats === null
        ? { expected_total: EXPECTED_SCENARIOS }
        : { ...stats, expected_total: EXPECTED_SCENARIOS },
    image,
    cutover_ready: cutoverReady,
    violations,
  };
}

export function validateManifest(manifest) {
  if (manifest === null || manifest === undefined) {
    return [
      violation(
        'manifest-missing',
        'the usability manifest was never written; a green job exit does not prove the lane ran',
      ),
    ];
  }
  if (
    typeof manifest !== 'object' ||
    manifest.schema_version !== 1 ||
    manifest.mode !== 'usability-lane' ||
    typeof manifest.status !== 'string'
  ) {
    return [violation('manifest-malformed', 'the manifest must be the usability-lane JSON object')];
  }
  const violations = [];
  const chromium = manifest.chromium;
  if (
    chromium === null ||
    typeof chromium !== 'object' ||
    chromium.launched !== true ||
    typeof chromium.version !== 'string' ||
    chromium.version === ''
  ) {
    violations.push(
      violation('manifest-chromium-unproven', 'the manifest does not prove a real Chromium launch'),
    );
  }
  const stats = manifest.scenarios;
  if (
    stats === null ||
    typeof stats !== 'object' ||
    stats.total !== EXPECTED_SCENARIOS ||
    stats.expected !== EXPECTED_SCENARIOS ||
    (stats.skipped ?? 1) > 0 ||
    (stats.unexpected ?? 1) > 0 ||
    (stats.flaky ?? 1) > 0
  ) {
    violations.push(
      violation(
        'manifest-scenarios-unproven',
        `the manifest does not prove ${EXPECTED_SCENARIOS}/${EXPECTED_SCENARIOS} executed scenarios`,
        `${EXPECTED_SCENARIOS} passed, 0 skipped/failed/flaky`,
        stats === null || typeof stats !== 'object'
          ? 'absent'
          : `total=${stats.total} expected=${stats.expected} skipped=${stats.skipped} failed=${stats.unexpected} flaky=${stats.flaky}`,
      ),
    );
  }
  if (manifest.cutover_ready === true) {
    const image = manifest.image;
    if (
      manifest.status !== 'ok' ||
      image === null ||
      typeof image !== 'object' ||
      image.state !== IMAGE_STATE_PUBLISHED ||
      typeof image.digest !== 'string' ||
      !SHA256_DIGEST.test(image.digest)
    ) {
      violations.push(
        violation(
          'manifest-cutover-inconsistent',
          'cutover_ready=true requires status=ok plus a published CI image digest in pins',
        ),
      );
    }
  }
  return violations;
}

function readOptionalText(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readOptionalJson(filePath) {
  const text = readOptionalText(filePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function manifestMain() {
  const gateDir = process.env.USABILITY_GATE_DIR ?? 'test-results/usability-gate';
  const probePath = process.env.USABILITY_PROBE_JSON ?? `${gateDir}/chromium-probe.json`;
  const reportPath = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? `${gateDir}/report.json`;
  const pinsPath = path.resolve(process.env.PINS_FILE ?? '.buildkite/pins.env');
  const outPath = process.env.USABILITY_MANIFEST_JSON ?? `${gateDir}/manifest.json`;

  const manifest = buildManifest({
    probe: readOptionalJson(probePath),
    reportText: readOptionalText(reportPath),
    pinsText: readOptionalText(pinsPath),
    env: process.env,
  });

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest)}\n`);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
  if (manifest.status !== 'ok') {
    for (const entry of manifest.violations) {
      process.stderr.write(`usability-lane: ${entry.code}: ${entry.message}\n`);
    }
  }
  process.exitCode = manifest.status === 'ok' && validateManifest(manifest).length === 0 ? 0 : 1;
}

if (process.argv[2] === '--manifest') manifestMain();
