import {
  CauseCategoryDeclaration,
  RenderConfig,
  SchedulingHints,
} from '@/core/schema/profile-decl';
import { z } from 'zod';
import { mathProfile } from './math/profile';
import { physicsProfile } from './physics/profile';
import { wenyanProfile } from './wenyan/profile';

export type SubjectId = string;
export const KNOWN_SUBJECT_IDS = ['wenyan', 'math', 'physics'] as const;
export type KnownSubjectId = (typeof KNOWN_SUBJECT_IDS)[number];

export const SubjectQuestionKindSchema = z.enum([
  'single_choice',
  'multiple_choice',
  'short_answer',
  'translation',
  'reading_comprehension',
  'proof',
  'calculation',
  'word_problem',
]);
export type SubjectQuestionKind = z.infer<typeof SubjectQuestionKindSchema>;

// Desired route families for subject policy. These are allowed to mention
// future strategies; judgeCapabilities below lists registry-backed runners.
export const JudgeRouteKindSchema = z.enum([
  'exact',
  'keyword',
  'semantic',
  'rubric',
  'steps',
  'multimodal_direct',
  'ai_flexible',
]);
export type JudgeRouteKind = z.infer<typeof JudgeRouteKindSchema>;

export const SubjectProfileSchema = z.object({
  id: z.string().trim().min(1),
  version: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  languageStyle: z.string().trim().min(1),
  questionKinds: z.array(SubjectQuestionKindSchema).min(1),
  judgePolicy: z.object({
    preferredRoutes: z.array(JudgeRouteKindSchema).min(1),
    notes: z.array(z.string()),
  }),
  exampleSources: z.array(z.string().trim().min(1)),
  noteTemplate: z.object({
    definition: z.string().trim().min(1),
    mechanism: z.string().trim().min(1),
    example: z.string().trim().min(1),
    pitfall: z.string().trim().min(1),
    check: z.string().trim().min(1),
  }),
  grounding: z.object({
    requirement: z.string().trim().min(1),
    allowedSources: z.array(z.string().trim().min(1)),
    uncertaintyPolicy: z.string().trim().min(1),
  }),
  promptFragments: z.object({
    roleNoun: z.string().trim().min(1),
    noteExamplePolicy: z.string().trim().min(1),
    variantExamplePolicy: z.string().trim().min(1),
    teachingStyle: z.string().trim().min(1),
    checkQuestionPolicy: z.string().trim().min(1),
    learningIntentPolicy: z.string().trim().min(1),
  }),
  causeCategories: z.array(CauseCategoryDeclaration).min(1),
  renderConfig: RenderConfig,
  schedulingHints: SchedulingHints,
  judgeCapabilities: z.array(z.string().trim().min(1)),
});
export type SubjectProfile = z.infer<typeof SubjectProfileSchema>;
export type SlimSubjectProfile = Pick<SubjectProfile, 'id' | 'displayName' | 'renderConfig'>;

const DEFAULT_SUBJECT_ID: KnownSubjectId = 'wenyan';

const DEFAULT_ALIASES: Record<string, SubjectId> = {
  classical_chinese: 'wenyan',
  chinese_classics: 'wenyan',
  math: 'math',
  mathematics: 'math',
  maths: 'math',
  wenyan: 'wenyan',
  physics: 'physics',
  physical: 'physics',
};

function normalizeSubjectKey(value: string): string {
  return value.trim().toLowerCase();
}

export class SubjectRegistry {
  private profiles = new Map<SubjectId, SubjectProfile>();
  private aliases = new Map<string, SubjectId>();
  private defaultId: SubjectId;

  constructor(defaultId: SubjectId = DEFAULT_SUBJECT_ID) {
    this.defaultId = defaultId;
    this.register(wenyanProfile);
    this.register(mathProfile);
    this.register(physicsProfile);
    for (const [alias, id] of Object.entries(DEFAULT_ALIASES)) {
      this.aliases.set(normalizeSubjectKey(alias), normalizeSubjectKey(id));
    }
  }

  register(profile: SubjectProfile, aliases: string[] = []): void {
    const id = normalizeSubjectKey(profile.id);
    if (id.length === 0) {
      throw new Error('SubjectProfile.id must be a non-empty string');
    }
    if (this.profiles.has(id)) {
      throw new Error(`Subject profile '${id}' already registered`);
    }
    const normalizedProfile = id === profile.id ? profile : { ...profile, id };
    this.profiles.set(id, normalizedProfile);
    this.aliases.set(id, id);

    for (const alias of aliases) {
      const key = normalizeSubjectKey(alias);
      if (key.length === 0) {
        throw new Error(`Alias for subject '${id}' must be non-empty`);
      }
      this.aliases.set(key, id);
    }
  }

  resolve(domain?: string | null): SubjectProfile {
    const key = domain ? normalizeSubjectKey(domain) : '';
    const resolvedId = key ? (this.aliases.get(key) ?? key) : this.defaultId;
    const fallback = this.profiles.get(this.defaultId);
    if (!fallback) {
      throw new Error(`Default subject profile '${this.defaultId}' is not registered`);
    }
    return this.profiles.get(resolvedId) ?? fallback;
  }

  get(id: SubjectId): SubjectProfile | undefined {
    return this.profiles.get(normalizeSubjectKey(id));
  }

  listIds(): SubjectId[] {
    return [...this.profiles.keys()];
  }

  listProfiles(): SubjectProfile[] {
    return [...this.profiles.values()];
  }
}

const defaultRegistry = new SubjectRegistry();

export const subjectProfiles: Record<string, SubjectProfile> = Object.fromEntries(
  defaultRegistry.listProfiles().map((profile) => [profile.id, profile]),
);

export const defaultSubjectProfile = defaultRegistry.resolve();

export function resolveSubjectProfile(domain?: string | null): SubjectProfile {
  return defaultRegistry.resolve(domain);
}

export function getDefaultSubjectRegistry(): SubjectRegistry {
  return defaultRegistry;
}

export function toSlimSubjectProfile(profile: SubjectProfile): SlimSubjectProfile {
  return {
    id: profile.id,
    displayName: profile.displayName,
    renderConfig: profile.renderConfig,
  };
}
