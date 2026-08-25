import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Violation, parsePins, validatePins } from './green-bridge-pins.mjs';
import {
  type ContextRecord,
  type GitProbe,
  markMetadataFailure,
  validateContext,
} from './verify-build-context.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const VALID_PINS = [
  '# YUK-916 Green Bridge Phase 1 pins. Verified 2026-08-25.',
  'GITHUB_ACTIONS_PLUGIN_SOURCE=buildkite-plugins/github-actions-buildkite-plugin',
  'GITHUB_ACTIONS_PLUGIN_RELEASE=v0.13.0',
  `GITHUB_ACTIONS_PLUGIN_COMMIT=${SHA_A}`,
  'GITHUB_ACTIONS_PLUGIN_OBSERVED_AT=2026-08-25',
  'NODE_VERSION=24.0.0',
  'PNPM_VERSION=11.13.1',
  'BUN_VERSION=1.3.14',
  'PIN_MAX_AGE_DAYS=30',
  'CI_IMAGE_REPO=ghcr.io/yukoval-dakia/the-learning-project/buildkite-ci',
  'CI_IMAGE_BASE_REF=mcr.microsoft.com/playwright:v1.62.1-noble',
  `CI_IMAGE_BASE_DIGEST=sha256:${'c'.repeat(64)}`,
  'CI_IMAGE_PLAYWRIGHT_VERSION=1.62.1',
  'CI_IMAGE_STATE=image_digest_pending_publication',
].join('\n');

const ciGateWorkflow = readFileSync('.github/workflows/ci-gate.yml', 'utf8');

describe('GitHub checkout parity receipt', () => {
  it('checks every CI Gate lane out at the PR head and uploads one identity receipt', () => {
    expect(ciGateWorkflow.match(/uses: actions\/checkout@v4/g)).toHaveLength(8);
    expect(
      ciGateWorkflow.match(
        /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/g,
      ),
    ).toHaveLength(8);
    expect(ciGateWorkflow).toContain('name: green-bridge-context-github');
    expect(ciGateWorkflow).toContain('node scripts/ci/verify-build-context.mjs');
  });
});

function gitProbe({
  head = SHA_A,
  tree = SHA_B,
  bases,
}: {
  head?: string | null;
  tree?: string | null;
  bases?: Record<string, string | null>;
} = {}): GitProbe {
  return {
    headCommit: () => head,
    headTree: () => tree,
    mergeBaseSha: (ref) => (bases && ref in bases ? bases[ref] : SHA_C),
  };
}

function codes(violations: Violation[]): string[] {
  return violations.map((entry) => entry.code);
}

describe('verify-build-context pins', () => {
  it('accepts fresh well-formed pins', () => {
    const { record } = validatePins({
      pinsText: VALID_PINS,
      now: new Date('2026-08-30T00:00:00Z'),
    });
    expect(record.status).toBe('ok');
    expect(record.violations).toEqual([]);
    expect(record.pins).toMatchObject({
      GITHUB_ACTIONS_PLUGIN_RELEASE: 'v0.13.0',
      age_days: 5,
    });
  });

  it('rejects pins whose observation date exceeds the freshness bound', () => {
    const { record } = validatePins({
      pinsText: VALID_PINS,
      now: new Date('2026-10-01T00:00:00Z'),
    });
    expect(record.status).toBe('failed');
    expect(codes(record.violations)).toContain('pins-stale');
  });

  it('rejects pins with missing required keys and malformed values', () => {
    const { violations } = validatePins({
      pinsText:
        'GITHUB_ACTIONS_PLUGIN_COMMIT=deadbeef\nGITHUB_ACTIONS_PLUGIN_RELEASE=0.13.0\nGITHUB_ACTIONS_PLUGIN_OBSERVED_AT=25/08/2026\nPIN_MAX_AGE_DAYS=soon',
      now: new Date('2026-08-30T00:00:00Z'),
    });
    const found = codes(violations);
    for (const code of [
      'pins-key-missing',
      'pins-plugin-commit-malformed',
      'pins-plugin-release-malformed',
      'pins-observed-at-invalid',
      'pins-max-age-invalid',
    ]) {
      expect(found).toContain(code);
    }
  });

  it('rejects unparsable lines but keeps valid ones', () => {
    const { pins, violations } = parsePins('GOOD_KEY=1\nnot a pin line\n= novalue\nOTHER_KEY=2');
    expect(pins).toEqual({ GOOD_KEY: '1', OTHER_KEY: '2' });
    expect(violations).toHaveLength(2);
  });
});

describe('verify-build-context context', () => {
  it('passes on a healthy push build with fresh pins', () => {
    const { record } = validateContext({
      env: {
        BUILDKITE: 'true',
        BUILDKITE_COMMIT: SHA_A,
        BUILDKITE_BRANCH: 'codex/yuk-916-ci-buildkite-shadow',
        BUILDKITE_BUILD_NUMBER: '6',
        BUILDKITE_PIPELINE_SLUG: 'the-learning-project-ci-shadow',
        BUILDKITE_PULL_REQUEST: 'false',
        BUILDKITE_PIPELINE_DEFAULT_BRANCH: 'main',
      },
      git: gitProbe(),
      pinsText: VALID_PINS,
      now: new Date('2026-08-30T00:00:00Z'),
    });
    expect(record.status).toBe('ok');
    expect(record.violations).toEqual([]);
    expect(record.head).toEqual({ commit: SHA_A, tree: SHA_B });
    expect(record.base).toEqual({ branch: 'main', sha: SHA_C });
    expect(record.pr).toBeNull();
    expect(record.github).toBeNull();
    expect(record.checks).toMatchObject({
      commit_matches_head: true,
      head_tree_resolved: true,
      base_present: true,
      pins_fresh: true,
    });
    expect(record.metadata).toBeNull();
  });

  it('passes on a healthy PR build and records the PR head and base', () => {
    const { record } = validateContext({
      env: {
        BUILDKITE: 'true',
        BUILDKITE_COMMIT: SHA_A,
        BUILDKITE_PULL_REQUEST: '7',
        BUILDKITE_PULL_REQUEST_BASE_BRANCH: 'main',
        BUILDKITE_JOB_ID: 'job-1',
        GITHUB_SHA: SHA_A,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_BEFORE: SHA_C,
      },
      git: gitProbe({ bases: { 'origin/main': SHA_C } }),
      pinsText: VALID_PINS,
      now: new Date('2026-08-30T00:00:00Z'),
    });
    expect(record.status).toBe('ok');
    expect(record.pr).toEqual({ number: 7, head_sha: SHA_A, base_branch: 'main', base_sha: SHA_C });
    expect(record.github).toEqual({ event_name: 'pull_request', sha: SHA_A, before: SHA_C });
    expect(record.checks.pr_head_present).toBe(true);
    expect(record.checks.github_sha_matches).toBe(true);
    expect(record.metadata).toEqual({ key: 'green-bridge-context', set: true });
  });

  it('fails when BUILDKITE_COMMIT differs from the checked-out HEAD', () => {
    const { record } = validateContext({
      env: { BUILDKITE: 'true', BUILDKITE_COMMIT: SHA_B },
      git: gitProbe(),
    });
    expect(record.status).toBe('failed');
    expect(codes(record.violations)).toContain('commit-head-mismatch');
    expect(record.checks.commit_matches_head).toBe(false);
  });

  it('fails on a malformed commit sha and on a missing buildkite context', () => {
    const malformed = validateContext({
      env: { BUILDKITE: 'true', BUILDKITE_COMMIT: 'a4dc032' },
      git: gitProbe(),
    });
    expect(codes(malformed.record.violations)).toContain('commit-malformed');

    const notBuildkite = validateContext({ env: { BUILDKITE_COMMIT: SHA_A }, git: gitProbe() });
    expect(codes(notBuildkite.record.violations)).toContain('not-buildkite-context');
  });

  it('fails when a provided GITHUB_SHA disagrees with BUILDKITE_COMMIT', () => {
    const { record } = validateContext({
      env: { BUILDKITE: 'true', BUILDKITE_COMMIT: SHA_A, GITHUB_SHA: SHA_B },
      git: gitProbe(),
    });
    expect(record.status).toBe('failed');
    expect(codes(record.violations)).toContain('github-sha-mismatch');
    expect(record.checks.github_sha_matches).toBe(false);
  });

  it('fails when the PR base merge-base does not resolve or the PR number is malformed', () => {
    const noBase = validateContext({
      env: { BUILDKITE: 'true', BUILDKITE_COMMIT: SHA_A, BUILDKITE_PULL_REQUEST: '9' },
      git: gitProbe({ bases: { 'origin/main': null } }),
    });
    expect(codes(noBase.record.violations)).toContain('pr-base-unresolved');

    const badNumber = validateContext({
      env: { BUILDKITE: 'true', BUILDKITE_COMMIT: SHA_A, BUILDKITE_PULL_REQUEST: 'yes' },
      git: gitProbe(),
    });
    expect(codes(badNumber.record.violations)).toContain('pr-number-malformed');
  });

  it('carries the pins error when PINS_FILE points at a missing file', () => {
    const { record } = validateContext({
      env: { BUILDKITE: 'true', BUILDKITE_COMMIT: SHA_A },
      git: gitProbe(),
      pinsError: { code: 'pins-unreadable', message: 'PINS_FILE=x does not exist' },
    });
    expect(record.status).toBe('failed');
    expect(codes(record.violations)).toContain('pins-unreadable');
    expect(record.checks.pins_fresh).toBe(false);
  });

  it('marks the record failed when Buildkite metadata cannot be stored', () => {
    const record: ContextRecord = validateContext({
      env: {
        BUILDKITE: 'true',
        BUILDKITE_COMMIT: SHA_A,
        BUILDKITE_PULL_REQUEST: 'false',
        BUILDKITE_JOB_ID: 'job-2',
      },
      git: gitProbe(),
    }).record;
    expect(record.status).toBe('ok');

    markMetadataFailure(record, 'buildkite-agent exited 1: not found');
    expect(record.status).toBe('failed');
    expect(record.metadata).toEqual({
      key: 'green-bridge-context',
      set: false,
      error: 'buildkite-agent exited 1: not found',
    });
    expect(codes(record.violations)).toContain('metadata-set-failed');
  });
});
