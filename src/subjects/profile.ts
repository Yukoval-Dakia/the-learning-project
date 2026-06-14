import { getDefaultRegistry } from '@/core/capability/judges';
import { validateProfile } from '@/core/capability/validate-profile';
import { generalProfile } from './general/profile';
import { mathProfile } from './math/profile';
import { physicsProfile } from './physics/profile';
import { type SlimSubjectProfile, type SubjectId, type SubjectProfile } from './profile-schema';
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

// YUK (wenyan deprotagonist): the neutral default is `general`, NOT a concrete
// sample subject. A null / unknown domain resolves to `general` (system font,
// generic voice) instead of inheriting wenyan's classical-Chinese privilege.
// `general` is intentionally a plain SubjectId (not KnownSubjectId): it is the
// fallback identity, never a node domain, so it stays out of KNOWN_SUBJECT_IDS
// (goal-scope candidates / derived `?subject=` axis iterate that list).
const DEFAULT_SUBJECT_ID: SubjectId = 'general';

// The generic registry no longer hardcodes any concrete-subject alias. Each
// sample subject self-declares its aliases at register() time (e.g. wenyan owns
// classical_chinese / chinese_classics), so the framework default stays
// subject-neutral and adding/removing a subject can't strand an orphan alias here.

function normalizeSubjectKey(value: string): string {
  return value.trim().toLowerCase();
}

function formatProfileRegistrationError(id: string, errors: string[]): string {
  return [
    `Subject profile '${id}' failed validation:`,
    ...errors.map((error) => `- ${error}`),
  ].join('\n');
}

export interface SubjectRegistrationResult {
  id: string;
  valid: boolean;
  errors: string[];
}

export interface SubjectRegistrationOptions {
  throwOnInvalid?: boolean;
}

export interface SubjectRegistryOptions {
  throwOnInvalid?: boolean;
}

export class SubjectRegistry {
  private profiles = new Map<SubjectId, SubjectProfile>();
  private aliases = new Map<string, SubjectId>();
  private defaultId: SubjectId;

  constructor(defaultId: SubjectId = DEFAULT_SUBJECT_ID, opts: SubjectRegistryOptions = {}) {
    this.defaultId = defaultId;
    const throwOnInvalid = opts.throwOnInvalid ?? true;
    // general = neutral default; registered first so it backs the default id.
    this.register(generalProfile, [], { throwOnInvalid });
    // Each sample subject self-declares its own aliases (归位) — the generic
    // registry no longer hardcodes any concrete-subject alias table.
    this.register(wenyanProfile, ['classical_chinese', 'chinese_classics'], { throwOnInvalid });
    this.register(mathProfile, ['mathematics', 'maths'], { throwOnInvalid });
    this.register(physicsProfile, ['physical'], { throwOnInvalid });
  }

  register(
    profile: SubjectProfile,
    aliases: string[] = [],
    opts: SubjectRegistrationOptions = {},
  ): SubjectRegistrationResult {
    const throwOnInvalid = opts.throwOnInvalid ?? true;
    const id = normalizeSubjectKey(profile.id);
    if (id.length === 0) {
      const errors = ['SubjectProfile.id must be a non-empty string'];
      if (throwOnInvalid) throw new Error(errors[0]);
      return { id: '<missing-id>', valid: false, errors };
    }
    if (this.profiles.has(id)) {
      const errors = [`Subject profile '${id}' already registered`];
      if (throwOnInvalid) throw new Error(errors[0]);
      return { id, valid: false, errors };
    }
    const normalizedProfile = id === profile.id ? profile : { ...profile, id };
    const validation = validateProfile(normalizedProfile, getDefaultRegistry());
    if (!validation.valid) {
      if (throwOnInvalid) {
        throw new Error(formatProfileRegistrationError(id, validation.errors));
      }
      return { id, valid: false, errors: validation.errors };
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
    return { id, valid: true, errors: [] };
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

  /**
   * Resolve a domain to its canonical subject id ONLY when the domain is a
   * GENUINE alias/id hit — returns `null` for a null/empty domain OR an
   * unrecognised string. Unlike `resolve()`, this never falls back to the default
   * subject, so callers can tell "genuinely wenyan" apart from "untagged /
   * unknown-domain" (YUK-288: the derived `?subject=` axis must NOT sweep
   * domainless or unknown-domain nodes into the default subject). Alias-aware
   * (classical_chinese → wenyan) where the bare-equality precedent
   * (tagging.ts:122) is not.
   */
  resolveKnownSubjectId(domain?: string | null): SubjectId | null {
    if (!domain) return null;
    const key = normalizeSubjectKey(domain);
    if (key.length === 0) return null;
    // A known alias maps to its id; a bare profile id is registered as a self
    // alias (register() does `this.aliases.set(id, id)`), so this single lookup
    // covers both. A miss means the domain is unrecognised → null (no fallback).
    const resolvedId = this.aliases.get(key);
    if (resolvedId === undefined) return null;
    return this.profiles.has(resolvedId) ? resolvedId : null;
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

/**
 * Resolve a domain to its canonical subject id ONLY on a genuine alias/id hit;
 * `null` for a null/unknown domain (no default-subject fallback). See
 * `SubjectRegistry.resolveKnownSubjectId`.
 */
export function resolveKnownSubjectId(domain?: string | null): SubjectId | null {
  return defaultRegistry.resolveKnownSubjectId(domain);
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
