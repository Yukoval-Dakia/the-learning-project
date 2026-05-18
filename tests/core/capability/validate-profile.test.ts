import { CapabilityRegistry } from '@/core/capability/registry';
import type { JudgeCapabilityRunner } from '@/core/capability/types';
import { type ProfileValidationResult, validateProfile } from '@/core/capability/validate-profile';
import type { CapabilityManifestT } from '@/core/schema/capability';
import type { SubjectProfile } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';

function makeStubJudge(id: string): JudgeCapabilityRunner {
  const manifest: CapabilityManifestT = {
    id,
    kind: 'judge',
    version: '1.0.0',
    input_schema: 'any',
    output_schema: 'JudgeResultV2',
    cost_class: 'local',
    latency_class: 'sync',
    stability: 'stable',
  };
  return {
    manifest,
    run: () => ({
      score: 1,
      score_meaning: 'correctness',
      coarse_outcome: 'correct',
      confidence: 1,
      capability_ref: { id, version: '1.0.0' },
      feedback_md: '',
      evidence_json: {},
    }),
  };
}

function makeRegistry(...ids: string[]): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const id of ids) registry.registerJudge(makeStubJudge(id));
  return registry;
}

function makeProfile(overrides: Partial<SubjectProfile> = {}): SubjectProfile {
  return {
    id: 'test',
    displayName: 'Test',
    version: '1.0.0',
    languageStyle: '',
    questionKinds: [],
    judgePolicy: { preferredRoutes: [], notes: [] },
    exampleSources: [],
    noteTemplate: {
      definition: '',
      mechanism: '',
      example: '',
      pitfall: '',
      check: '',
    },
    grounding: { requirement: '', allowedSources: [], uncertaintyPolicy: '' },
    promptFragments: {
      roleNoun: '',
      noteExamplePolicy: '',
      variantExamplePolicy: '',
      teachingStyle: '',
      checkQuestionPolicy: '',
      learningIntentPolicy: '',
    },
    causeCategories: [
      { id: 'concept', label: '概念' },
      { id: 'memory', label: '记忆' },
    ],
    renderConfig: {
      font_family: 'system',
      notation: null,
      code_highlight: null,
    },
    schedulingHints: { default_policy: 'fsrs' },
    judgeCapabilities: ['exact', 'keyword'],
    ...overrides,
  } as SubjectProfile;
}

describe('validateProfile', () => {
  it('passes for a valid profile with matching registry', () => {
    const result = validateProfile(makeProfile(), makeRegistry('exact', 'keyword'));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when declared judge capability is not in registry', () => {
    const result = validateProfile(
      makeProfile({ judgeCapabilities: ['exact', 'semantic'] }),
      makeRegistry('exact', 'keyword'),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('semantic'))).toBe(true);
  });

  it('fails when causeCategories has duplicate ids', () => {
    const result = validateProfile(
      makeProfile({
        causeCategories: [
          { id: 'concept', label: 'A' },
          { id: 'concept', label: 'B' },
        ],
      }),
      makeRegistry('exact', 'keyword'),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('duplicate'))).toBe(true);
  });

  it('fails when causeCategory id has invalid format', () => {
    const result = validateProfile(
      makeProfile({
        causeCategories: [{ id: 'Has Space', label: 'bad' }],
      }),
      makeRegistry('exact', 'keyword'),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('format'))).toBe(true);
  });

  it('fails when version is empty', () => {
    const result = validateProfile(makeProfile({ version: '' }), makeRegistry('exact', 'keyword'));
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('version'))).toBe(true);
  });

  it('fails when causeCategories is empty', () => {
    const result = validateProfile(
      makeProfile({ causeCategories: [] }),
      makeRegistry('exact', 'keyword'),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('causeCategories'))).toBe(true);
  });

  it('warns (but does not fail) for deprecated capability', () => {
    const registry = new CapabilityRegistry();
    const deprecated: CapabilityManifestT = {
      id: 'old_judge',
      kind: 'judge',
      version: '1.0.0',
      input_schema: 'any',
      output_schema: 'JudgeResultV2',
      cost_class: 'local',
      latency_class: 'sync',
      stability: 'deprecated',
      replaced_by: 'new_judge',
    };
    registry.registerJudge({
      manifest: deprecated,
      run: () => ({
        score: 0,
        score_meaning: 'correctness',
        coarse_outcome: 'incorrect',
        confidence: 0,
        capability_ref: { id: 'old_judge', version: '1.0.0' },
        feedback_md: '',
        evidence_json: {},
      }),
    });

    const result: ProfileValidationResult = validateProfile(
      makeProfile({ judgeCapabilities: ['old_judge'] }),
      registry,
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('deprecated'))).toBe(true);
  });
});
