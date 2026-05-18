import type {
  CauseCategoryDeclarationT,
  RenderConfigT,
  SchedulingHintsT,
} from '@/core/schema/profile-decl';
import { mathProfile } from './math/profile';
import { wenyanProfile } from './wenyan/profile';

export type SubjectId = string;
export const KNOWN_SUBJECT_IDS = ['wenyan', 'math'] as const;
export type KnownSubjectId = (typeof KNOWN_SUBJECT_IDS)[number];

export type SubjectQuestionKind =
  | 'single_choice'
  | 'multiple_choice'
  | 'short_answer'
  | 'translation'
  | 'reading_comprehension'
  | 'proof'
  | 'calculation'
  | 'word_problem';

export type JudgeRouteKind =
  | 'exact'
  | 'keyword'
  | 'semantic'
  | 'rubric'
  | 'steps'
  | 'multimodal_direct'
  | 'ai_flexible';

export interface SubjectProfile {
  id: SubjectId;
  version: string;
  displayName: string;
  languageStyle: string;
  questionKinds: SubjectQuestionKind[];
  judgePolicy: {
    preferredRoutes: JudgeRouteKind[];
    notes: string[];
  };
  exampleSources: string[];
  noteTemplate: {
    definition: string;
    mechanism: string;
    example: string;
    pitfall: string;
    check: string;
  };
  grounding: {
    requirement: string;
    allowedSources: string[];
    uncertaintyPolicy: string;
  };
  promptFragments: {
    roleNoun: string;
    noteExamplePolicy: string;
    variantExamplePolicy: string;
    teachingStyle: string;
    checkQuestionPolicy: string;
    learningIntentPolicy: string;
  };
  causeCategories: CauseCategoryDeclarationT[];
  renderConfig: RenderConfigT;
  schedulingHints: SchedulingHintsT;
  judgeCapabilities: string[];
}

const DEFAULT_SUBJECT_ID: KnownSubjectId = 'wenyan';

const DEFAULT_ALIASES: Record<string, SubjectId> = {
  classical_chinese: 'wenyan',
  chinese_classics: 'wenyan',
  math: 'math',
  mathematics: 'math',
  maths: 'math',
  wenyan: 'wenyan',
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
    for (const [alias, id] of Object.entries(DEFAULT_ALIASES)) {
      this.aliases.set(normalizeSubjectKey(alias), normalizeSubjectKey(id));
    }
  }

  register(profile: SubjectProfile, aliases: string[] = []): void {
    const id = normalizeSubjectKey(profile.id);
    if (id.length === 0) {
      throw new Error('SubjectProfile.id must be a non-empty string');
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
