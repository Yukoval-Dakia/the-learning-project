import { getDefaultRegistry } from '@/core/capability/judges';
import { validateProfile } from '@/core/capability/validate-profile';
import { generalProfile } from './general/profile';
import { mathProfile } from './math/profile';
import { physicsProfile } from './physics/profile';
import type { SlimSubjectProfile, SubjectId, SubjectProfile } from './profile-schema';
import { yuwenProfile } from './yuwen/profile';

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
// generic voice) instead of inheriting the classical-Chinese privilege.
// `general` is intentionally a plain SubjectId (not KnownSubjectId): it is the
// fallback identity, never a node domain, so it stays out of KNOWN_SUBJECT_IDS
// (goal-scope candidates / derived `?subject=` axis iterate that list).
const DEFAULT_SUBJECT_ID: SubjectId = 'general';

// YUK-599 — builtin 别名的单一来源：registry 构造器与 migrate 的种子 claims
// （reconcileBuiltinTraits）共用，防两处漂移。YUK-249：wenyan 是改名前 canonical，
// 降级为 alias 使 legacy domain='wenyan' 数据/旧备份/历史 event payload 归一到 yuwen。
export const BUILTIN_SUBJECT_ALIASES: Record<string, readonly string[]> = {
  general: [],
  yuwen: ['wenyan', 'classical_chinese', 'chinese_classics'],
  math: ['mathematics', 'maths'],
  physics: ['physical'],
};

// The generic registry no longer hardcodes any concrete-subject alias. Each
// sample subject self-declares its aliases at register() time (e.g. yuwen owns
// the legacy `wenyan` id plus classical_chinese / chinese_classics), so the
// framework default stays subject-neutral and adding/removing a subject can't
// strand an orphan alias here. YUK-249: the subject was renamed wenyan → yuwen;
// the old canonical id `wenyan` is DEMOTED to an alias so legacy domain='wenyan'
// data, old backup imports, and historical event payloads all resolve to yuwen.

// YUK-599 (v2 §2.2 承接) — 补 NFC：CJK 恒等、无 locale 坑；写门 / DB 入库
// （display_name_norm、claim.name_norm）/ 内存 Map 键必须共用本函数（导出即合同）。
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
    // registry no longer hardcodes any concrete-subject alias table. YUK-249:
    // `wenyan` is the pre-rename canonical id, now demoted to an alias so legacy
    // domain='wenyan' data / old backups / event payloads normalise to yuwen.
    this.register(yuwenProfile, [...(BUILTIN_SUBJECT_ALIASES.yuwen ?? [])], {
      throwOnInvalid,
    });
    this.register(mathProfile, [...(BUILTIN_SUBJECT_ALIASES.math ?? [])], { throwOnInvalid });
    this.register(physicsProfile, [...(BUILTIN_SUBJECT_ALIASES.physics ?? [])], {
      throwOnInvalid,
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
    this.registerAliases(id, aliases);
    return { id, valid: true, errors: [] };
  }

  // YUK-599 (v2 §2.2) — alias 抢占显式冲突：同串已被**他科**占用 → throw，
  // 不再静默覆盖（旧 :118 直接 .set 会让 alias 抢 'math' 静默改写 builtin 自别名）。
  // `!== id` 谓词放行同科重复声明（幂等重装）。DB claim 表 PK 是第二层兜底。
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
   * YUK-599 (v2 §4 水合) — register-with-replace：同 id 重装（DB wins，装配结果
   * 覆盖内存旧条目 + 重指 alias）；新 id 走完整 register 校验路径。水合用
   * `throwOnInvalid: false`（坏行 skip+WARN 不炸进程——never-throws 矩阵）。
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
    this.registerAliases(id, aliases);
    return { id, valid: true, errors: [] };
  }

  /**
   * YUK-599 — reconcileCustomIds 防御网的摘除原语：删 profile + 指向它的全部
   * alias。唯一真实触发 = restore 使 DB 行集收缩；调用方（hydrate）负责
   * 「builtin 四种子是地板永不摘」的守卫，本方法不自判。
   */
  remove(id: SubjectId): boolean {
    const key = normalizeSubjectKey(id);
    if (!this.profiles.delete(key)) return false;
    for (const [alias, target] of this.aliases) {
      if (target === key) this.aliases.delete(alias);
    }
    return true;
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
   * subject, so callers can tell "genuinely yuwen" apart from "untagged /
   * unknown-domain" (YUK-288: the derived `?subject=` axis must NOT sweep
   * domainless or unknown-domain nodes into the default subject). Alias-aware
   * (wenyan / classical_chinese → yuwen) where the bare-equality precedent
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
