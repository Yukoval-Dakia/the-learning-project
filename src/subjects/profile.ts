import { getDefaultRegistry } from '@/core/capability/judges';
import { validateProfile } from '@/core/capability/validate-profile';
import { mathProfile } from './math/profile';
import { physicsProfile } from './physics/profile';
import {
  KNOWN_SUBJECT_IDS,
  type KnownSubjectId,
  type SlimSubjectProfile,
  type SubjectId,
  type SubjectProfile,
} from './profile-schema';
import { wenyanProfile } from './wenyan/profile';

export {
  JudgeRouteKindSchema,
  KNOWN_SUBJECT_IDS,
  SubjectProfileSchema,
  SubjectQuestionKindSchema,
  type JudgeRouteKind,
  type KnownSubjectId,
  type SlimSubjectProfile,
  type SubjectId,
  type SubjectProfile,
  type SubjectQuestionKind,
} from './profile-schema';

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

function formatProfileRegistrationError(id: string, errors: string[]): string {
  return [
    `Subject profile '${id}' failed validation:`,
    ...errors.map((error) => `- ${error}`),
  ].join('\n');
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
    const validation = validateProfile(normalizedProfile, getDefaultRegistry());
    if (!validation.valid) {
      throw new Error(formatProfileRegistrationError(id, validation.errors));
    }

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
