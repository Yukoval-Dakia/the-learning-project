const FULL_SHA = /^[0-9a-f]{40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

const REQUIRED_PIN_KEYS = [
  'GITHUB_ACTIONS_PLUGIN_SOURCE',
  'GITHUB_ACTIONS_PLUGIN_RELEASE',
  'GITHUB_ACTIONS_PLUGIN_COMMIT',
  'GITHUB_ACTIONS_PLUGIN_OBSERVED_AT',
  'NODE_VERSION',
  'PNPM_VERSION',
  'BUN_VERSION',
  'PIN_MAX_AGE_DAYS',
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
