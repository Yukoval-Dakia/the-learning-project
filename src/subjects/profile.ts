import { getDefaultRegistry } from '@/core/capability/judges';
import { validateProfile } from '@/core/capability/validate-profile';
import { generalProfile } from './general/profile';
import { mathProfile } from './math/profile';
import { physicsProfile } from './physics/profile';
import type { SlimSubjectProfile, SubjectId, SubjectProfile } from './profile-schema';
import { yuwenProfile } from './yuwen/profile';

export {
  BUILTIN_IDS,
  type BuiltinId,
  type JudgeRouteKind,
  JudgeRouteKindSchema,
  KNOWN_SUBJECT_IDS,
  type KnownSubjectId,
  type SlimSubjectProfile,
  type SubjectId,
  type SubjectProfile,
  SubjectProfileSchema,
  type SubjectQuestionKind,
  SubjectQuestionKindSchema,
} from './profile-schema';

// Null / unknown domains resolve to the neutral `general` profile, never to a
// sample subject. `general` is the fallback identity, so it stays out of the
// selectable set (goal scope and the derived subject axis iterate that set).
const DEFAULT_SUBJECT_ID: SubjectId = 'general';

// Single source for builtin aliases, shared by the registry and trait seeding.
export const BUILTIN_SUBJECT_ALIASES: Record<string, readonly string[]> = {
  general: [],
  yuwen: ['wenyan', 'classical_chinese', 'chinese_classics'],
  math: ['mathematics', 'maths'],
  physics: ['physical'],
};

// NFC + trim + lowercase. Write gates, DB norm columns, and in-memory map keys
// must all use this so CJK and case variants resolve identically.
export function normalizeSubjectKey(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
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
  // Control-plane metadata supplied by hydration; custom subjects default to
  // { isBuiltin: false, isSelectable: true, retiredAt: null }.
  meta?: SubjectRegistryEntryMeta;
}

export interface SubjectRegistryOptions {
  throwOnInvalid?: boolean;
}

// Two independent exclusions: general is structurally unselectable, while a
// retired subject is unselectable by state and can be restored.
export interface SubjectRegistryEntryMeta {
  isBuiltin: boolean;
  isSelectable: boolean;
  retiredAt: Date | null;
}

export type SubjectIdScope = 'resolvable' | 'selectable';

export class SubjectRegistry {
  private profiles = new Map<SubjectId, SubjectProfile>();
  private aliases = new Map<string, SubjectId>();
  private meta = new Map<SubjectId, SubjectRegistryEntryMeta>();
  private defaultId: SubjectId;

  constructor(defaultId: SubjectId = DEFAULT_SUBJECT_ID, opts: SubjectRegistryOptions = {}) {
    this.defaultId = defaultId;
    const throwOnInvalid = opts.throwOnInvalid ?? true;
    // Registered first so it backs the default id; never selectable.
    this.register(generalProfile, [], {
      throwOnInvalid,
      meta: { isBuiltin: true, isSelectable: false, retiredAt: null },
    });
    const builtinMeta: SubjectRegistryEntryMeta = {
      isBuiltin: true,
      isSelectable: true,
      retiredAt: null,
    };
    this.register(yuwenProfile, [...(BUILTIN_SUBJECT_ALIASES.yuwen ?? [])], {
      throwOnInvalid,
      meta: builtinMeta,
    });
    this.register(mathProfile, [...(BUILTIN_SUBJECT_ALIASES.math ?? [])], {
      throwOnInvalid,
      meta: builtinMeta,
    });
    this.register(physicsProfile, [...(BUILTIN_SUBJECT_ALIASES.physics ?? [])], {
      throwOnInvalid,
      meta: builtinMeta,
    });
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
    this.meta.set(id, opts.meta ?? { isBuiltin: false, isSelectable: true, retiredAt: null });
    this.registerAliases(id, aliases);
    return { id, valid: true, errors: [] };
  }

  // An alias claimed by another subject is a hard error, not a silent overwrite;
  // redeclaring an alias for the same subject is idempotent.
  private registerAliases(id: SubjectId, aliases: string[]): void {
    for (const alias of aliases) {
      const key = normalizeSubjectKey(alias);
      if (key.length === 0) {
        throw new Error(`Alias for subject '${id}' must be non-empty`);
      }
      const claimed = this.aliases.get(key);
      if (claimed !== undefined && claimed !== id) {
        throw new Error(`Alias '${key}' for subject '${id}' is already claimed by '${claimed}'`);
      }
      this.aliases.set(key, id);
    }
  }

  /**
   * Register-or-replace for hydration. Hydration passes throwOnInvalid: false so
   * one bad row is skipped instead of crashing boot.
   */
  upsert(
    profile: SubjectProfile,
    aliases: string[] = [],
    opts: SubjectRegistrationOptions = {},
  ): SubjectRegistrationResult {
    const id = normalizeSubjectKey(profile.id);
    if (!this.profiles.has(id)) {
      return this.register(profile, aliases, opts);
    }
    const throwOnInvalid = opts.throwOnInvalid ?? true;
    const normalizedProfile = id === profile.id ? profile : { ...profile, id };
    const validation = validateProfile(normalizedProfile, getDefaultRegistry());
    if (!validation.valid) {
      if (throwOnInvalid) {
        throw new Error(formatProfileRegistrationError(id, validation.errors));
      }
      return { id, valid: false, errors: validation.errors };
    }
    this.profiles.set(id, normalizedProfile);
    if (opts.meta) this.meta.set(id, opts.meta);
    this.registerAliases(id, aliases);
    return { id, valid: true, errors: [] };
  }

  /**
   * Remove a profile and every alias pointing at it. Only a shrinking DB row set
   * reaches this; the caller guards that builtin seeds are never removed.
   */
  remove(id: SubjectId): boolean {
    const key = normalizeSubjectKey(id);
    if (!this.profiles.delete(key)) return false;
    this.meta.delete(key);
    for (const [alias, target] of this.aliases) {
      if (target === key) this.aliases.delete(alias);
    }
    return true;
  }

  // resolvable includes retired subjects so old data never dangles; selectable
  // excludes both structural and retired exclusions.
  getMeta(id: SubjectId): SubjectRegistryEntryMeta | undefined {
    return this.meta.get(normalizeSubjectKey(id));
  }

  listIds(scope: SubjectIdScope = 'resolvable'): SubjectId[] {
    const all = [...this.profiles.keys()];
    if (scope === 'resolvable') return all;
    return all.filter((id) => {
      const m = this.meta.get(id);
      return m?.isSelectable === true && m.retiredAt === null;
    });
  }

  getSelectableSubjectIds(): SubjectId[] {
    return this.listIds('selectable');
  }

  listAliasesFor(id: SubjectId): string[] {
    const key = normalizeSubjectKey(id);
    const out: string[] = [];
    for (const [alias, target] of this.aliases) {
      if (target === key && alias !== key) out.push(alias);
    }
    return out;
  }

  getResolvableSubjectIds(): SubjectId[] {
    return this.listIds('resolvable');
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
   * Canonical id only on a genuine alias/id hit; null for a missing or unknown
   * domain. Unlike resolve(), this never falls back, so callers can tell a real
   * subject from an untagged node.
   */
  resolveKnownSubjectId(domain?: string | null): SubjectId | null {
    if (!domain) return null;
    const key = normalizeSubjectKey(domain);
    if (key.length === 0) return null;
    // A profile id is registered as its own alias, so one lookup covers both.
    const resolvedId = this.aliases.get(key);
    if (resolvedId === undefined) return null;
    return this.profiles.has(resolvedId) ? resolvedId : null;
  }

  /**
   * Canonical id only for a currently selectable subject. `general`, retired
   * subjects, and unknown strings return null; this is the write-side predicate
   * for a valid knowledge-node domain.
   */
  resolveSelectableSubjectId(domain?: string | null): SubjectId | null {
    const resolvedId = this.resolveKnownSubjectId(domain);
    if (!resolvedId) return null;
    const meta = this.meta.get(resolvedId);
    return meta?.isSelectable === true && meta.retiredAt === null ? resolvedId : null;
  }

  get(id: SubjectId): SubjectProfile | undefined {
    return this.profiles.get(normalizeSubjectKey(id));
  }

  listProfiles(): SubjectProfile[] {
    return [...this.profiles.values()];
  }
}

const defaultRegistry = new SubjectRegistry();

// Import-time code snapshot; hydration does not update it. Use it only where a
// compile-time floor is required (seeds, migration single-writer, SPA bootstrap);
// live reads go through resolveSubjectProfile() or the registry.
export const subjectProfiles: Record<string, SubjectProfile> = Object.fromEntries(
  defaultRegistry.listProfiles().map((profile) => [profile.id, profile]),
);

/** @deprecated Use resolveSubjectProfile() for live values. */
export const defaultSubjectProfile = defaultRegistry.resolve();

export function resolveSubjectProfile(domain?: string | null): SubjectProfile {
  return defaultRegistry.resolve(domain);
}

/**
 * Canonical id only on a genuine hit; null for unknown domains, with no default
 * fallback.
 */
export function resolveKnownSubjectId(domain?: string | null): SubjectId | null {
  return defaultRegistry.resolveKnownSubjectId(domain);
}

/**
 * Canonical id only for a selectable subject; general, retired, and unknown all
 * return null. `general` is the fallback identity and never a persisted domain.
 */
export function resolveSelectableSubjectId(domain?: string | null): SubjectId | null {
  return defaultRegistry.resolveSelectableSubjectId(domain);
}

/**
 * The value to store as knowledge.domain: a selectable subject (or alias) becomes
 * its canonical id, `general` becomes null (inherit), and anything unrecognized is
 * kept verbatim so pre-hydration custom subjects still round-trip.
 */
export function sanitizeProposedNodeDomain(domain?: string | null): string | null {
  const selectable = resolveSelectableSubjectId(domain);
  if (selectable) return selectable;
  if (resolveKnownSubjectId(domain) === 'general') return null;
  const raw = domain?.trim();
  return raw || null;
}

// AI classification vocabulary: opaque ids alone carry no signal, so display
// names are the labels while ids stay verbatim keys. Read the live selectable
// registry, never the code snapshot; general is never listed.
export interface KnownSubject {
  id: string;
  display_name: string;
  aliases?: string[];
}

export function getKnownSubjects(): KnownSubject[] {
  return defaultRegistry.getSelectableSubjectIds().flatMap((id) => {
    const profile = defaultRegistry.get(id);
    if (!profile) return [];
    const aliases = defaultRegistry.listAliasesFor(id);
    return [
      {
        id,
        display_name: profile.displayName,
        ...(aliases.length > 0 ? { aliases } : {}),
      },
    ];
  });
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
