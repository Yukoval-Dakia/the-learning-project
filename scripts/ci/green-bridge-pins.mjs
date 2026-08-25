const FULL_SHA = /^[0-9a-f]{40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const MS_PER_DAY = 86_400_000;

// YUK-917: the runner-lane CI image lifecycle. PENDING means the GHCR image has
// not been published yet (or not yet recorded); pins validation forbids a
// digest in that state, and the usability manifest keeps cutover_ready=false.
export const IMAGE_STATE_PENDING = 'image_digest_pending_publication';
export const IMAGE_STATE_PUBLISHED = 'image_digest_published';
const IMAGE_STATES = [IMAGE_STATE_PENDING, IMAGE_STATE_PUBLISHED];

const REQUIRED_PIN_KEYS = [
  'GITHUB_ACTIONS_PLUGIN_SOURCE',
  'GITHUB_ACTIONS_PLUGIN_RELEASE',
  'GITHUB_ACTIONS_PLUGIN_COMMIT',
  'GITHUB_ACTIONS_PLUGIN_OBSERVED_AT',
  'NODE_VERSION',
  'PNPM_VERSION',
  'BUN_VERSION',
  'PIN_MAX_AGE_DAYS',
  'CI_IMAGE_REPO',
  'CI_IMAGE_BASE_REF',
  'CI_IMAGE_BASE_DIGEST',
  'CI_IMAGE_PLAYWRIGHT_VERSION',
  'CI_IMAGE_STATE',
];

export function violation(code, message, expected, actual) {
  return {
    code,
    message,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  };
}

export function parsePins(pinsText) {
  const pins = {};
  const violations = [];
  for (const rawLine of pinsText.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const key = eq >= 0 ? line.slice(0, eq).trim() : '';
    const value = eq >= 0 ? line.slice(eq + 1).trim() : '';
    if (eq < 0 || !/^[A-Z][A-Z0-9_]*$/.test(key) || value === '') {
      violations.push(violation('pins-line-malformed', `unparsable pins line: ${line}`));
      continue;
    }
    pins[key] = value;
  }
  return { pins, violations };
}

export function validatePins({ pinsText, now = new Date() }) {
  const { pins, violations } = parsePins(pinsText);
  for (const key of REQUIRED_PIN_KEYS) {
    if (!(key in pins))
      violations.push(violation('pins-key-missing', `required pin ${key} is absent`));
  }
  if (pins.PIN_MAX_AGE_DAYS !== undefined && !/^\d+$/.test(pins.PIN_MAX_AGE_DAYS)) {
    violations.push(
      violation('pins-max-age-invalid', 'PIN_MAX_AGE_DAYS must be a non-negative integer'),
    );
  }
  if (
    pins.GITHUB_ACTIONS_PLUGIN_COMMIT !== undefined &&
    !FULL_SHA.test(pins.GITHUB_ACTIONS_PLUGIN_COMMIT)
  ) {
    violations.push(
      violation(
        'pins-plugin-commit-malformed',
        'GITHUB_ACTIONS_PLUGIN_COMMIT must be a full 40-hex sha',
      ),
    );
  }
  if (
    pins.GITHUB_ACTIONS_PLUGIN_RELEASE !== undefined &&
    !/^v\d+\.\d+\.\d+$/.test(pins.GITHUB_ACTIONS_PLUGIN_RELEASE)
  ) {
    violations.push(
      violation(
        'pins-plugin-release-malformed',
        'GITHUB_ACTIONS_PLUGIN_RELEASE must look like vX.Y.Z',
      ),
    );
  }

  if (pins.CI_IMAGE_STATE !== undefined && !IMAGE_STATES.includes(pins.CI_IMAGE_STATE)) {
    violations.push(
      violation(
        'ci-image-state-invalid',
        `CI_IMAGE_STATE must be ${IMAGE_STATES.join(' or ')}`,
        IMAGE_STATES.join(' | '),
        pins.CI_IMAGE_STATE,
      ),
    );
  }
  if (pins.CI_IMAGE_BASE_DIGEST !== undefined && !SHA256_DIGEST.test(pins.CI_IMAGE_BASE_DIGEST)) {
    violations.push(
      violation('ci-image-base-digest-malformed', 'CI_IMAGE_BASE_DIGEST must be sha256:<64 hex>'),
    );
  }
  if (
    pins.CI_IMAGE_PLAYWRIGHT_VERSION !== undefined &&
    !SEMVER.test(pins.CI_IMAGE_PLAYWRIGHT_VERSION)
  ) {
    violations.push(
      violation(
        'ci-image-playwright-version-malformed',
        'CI_IMAGE_PLAYWRIGHT_VERSION must be X.Y.Z',
      ),
    );
  }
  const imageMaxAgeDays = Number(pins.PIN_MAX_AGE_DAYS);
  if (pins.CI_IMAGE_STATE === IMAGE_STATE_PENDING) {
    if (pins.CI_IMAGE_DIGEST !== undefined) {
      violations.push(
        violation(
          'ci-image-digest-forbidden',
          `a ${IMAGE_STATE_PENDING} image must not claim a digest; publish via .github/workflows/buildkite-ci-image.yml and record it first`,
        ),
      );
    }
  } else if (pins.CI_IMAGE_STATE === IMAGE_STATE_PUBLISHED) {
    if (pins.CI_IMAGE_DIGEST === undefined) {
      violations.push(
        violation('ci-image-digest-missing', 'a published image must record CI_IMAGE_DIGEST'),
      );
    } else if (!SHA256_DIGEST.test(pins.CI_IMAGE_DIGEST)) {
      violations.push(
        violation('ci-image-digest-malformed', 'CI_IMAGE_DIGEST must be sha256:<64 hex>'),
      );
    }
    const publishedAt = pins.CI_IMAGE_PUBLISHED_AT;
    if (publishedAt === undefined) {
      violations.push(
        violation(
          'ci-image-published-at-missing',
          'a published image must record CI_IMAGE_PUBLISHED_AT (re-observe within PIN_MAX_AGE_DAYS)',
        ),
      );
    } else if (!ISO_DATE.test(publishedAt)) {
      violations.push(
        violation('ci-image-published-at-invalid', 'CI_IMAGE_PUBLISHED_AT must be YYYY-MM-DD'),
      );
    } else if (
      Number.isInteger(imageMaxAgeDays) &&
      Math.floor((now.getTime() - Date.parse(`${publishedAt}T00:00:00Z`)) / MS_PER_DAY) >
        imageMaxAgeDays
    ) {
      violations.push(
        violation(
          'ci-image-published-stale',
          `the published image digest was observed more than ${pins.PIN_MAX_AGE_DAYS} days ago; re-verify it against GHCR`,
        ),
      );
    }
  }

  let ageDays = null;
  const observedAt = pins.GITHUB_ACTIONS_PLUGIN_OBSERVED_AT;
  if (observedAt !== undefined) {
    const observedMs = ISO_DATE.test(observedAt)
      ? Date.parse(`${observedAt}T00:00:00Z`)
      : Number.NaN;
    const maxAgeDays = Number(pins.PIN_MAX_AGE_DAYS);
    if (Number.isNaN(observedMs)) {
      violations.push(
        violation(
          'pins-observed-at-invalid',
          'GITHUB_ACTIONS_PLUGIN_OBSERVED_AT must be YYYY-MM-DD',
        ),
      );
    } else {
      ageDays = Math.floor((now.getTime() - observedMs) / MS_PER_DAY);
      if (Number.isInteger(maxAgeDays) && ageDays > maxAgeDays) {
        violations.push(
          violation(
            'pins-stale',
            `pins observed ${ageDays} days ago exceed the ${pins.PIN_MAX_AGE_DAYS}-day freshness bound`,
            `age <= ${pins.PIN_MAX_AGE_DAYS} days`,
            `age ${ageDays} days`,
          ),
        );
      }
    }
  }

  const record = {
    schema_version: 1,
    mode: 'pins',
    status: violations.length === 0 ? 'ok' : 'failed',
    pins: { ...pins, age_days: ageDays },
    violations,
  };
  return { pins, violations, record };
}
