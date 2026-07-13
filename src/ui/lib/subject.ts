import {
  BUILTIN_IDS,
  normalizeSubjectKey,
  resolveKnownSubjectId,
  resolveSubjectProfile,
  subjectProfiles,
  toSlimSubjectProfile,
} from '@/subjects/profile';
import type { CSSProperties } from 'react';

// YUK-249 — registry-driven subject enumeration for UI subject pickers / filters.
// The concrete subjects a picker shows are DERIVED from the registry
// (KNOWN_SUBJECT_IDS × displayName), never hardcoded — so registering / renaming
// a subject flows to every picker and a ghost chip (e.g. a subject with no
// profile, like the old `english`) can't linger. Accent color stays a UI-side
// concern (map-by-id in each page, default for unknown), NOT a profile-schema field.
export interface SubjectChoice {
  id: string;
  label: string;
  configurationStatus: SubjectConfigurationStatus;
}

export type SubjectConfigurationStatus = 'configured' | 'general-fallback' | 'unconfigured';

// YUK-598 — provider 行的最小形状（useSubjects().subjects 可直接传入）。
export interface SubjectRowLike {
  id: string;
  displayName: string;
  aliases?: readonly string[];
  configurationStatus?: SubjectConfigurationStatus;
}

function displayLabel(row: SubjectRowLike): string {
  return row.configurationStatus === 'unconfigured'
    ? `未配置学科 · ${row.displayName}`
    : row.displayName;
}

export function subjectIdentityKey(
  subject: string | null,
  rows?: readonly SubjectRowLike[],
): string | null {
  if (!subject) return null;
  const key = normalizeSubjectKey(subject);
  const row = rows?.find(
    (candidate) =>
      normalizeSubjectKey(candidate.id) === key ||
      candidate.aliases?.some((alias) => normalizeSubjectKey(alias) === key),
  );
  return row?.id ?? resolveKnownSubjectId(subject) ?? key;
}

// YUK-598 / YUK-628 rows 参数化：传入 provider 行（注册 profile + observed raw domain）
// 即行驱动；消费者自行决定 unconfigured 行是可筛选还是只读禁选；
// 省略/空数组 = 编译期 builtin 投影（断网/首帧/未 hook 化调用点的原行为，逐位不变）。
export function listSubjectChoices(rows?: readonly SubjectRowLike[]): SubjectChoice[] {
  if (rows && rows.length > 0) {
    return rows.map((r) => ({
      id: r.id,
      label: displayLabel(r),
      configurationStatus: r.configurationStatus ?? 'configured',
    }));
  }
  return BUILTIN_IDS.map((id) => ({
    id,
    label: subjectProfiles[id]?.displayName ?? id,
    configurationStatus: 'configured',
  }));
}

// Canonical display label for a raw domain / alias / profile id, registry-driven
// and alias-aware (legacy `wenyan` → yuwen). Falls back to the raw string for an
// unregistered value so callers never render an empty label.
export function subjectDisplayName(subject: string, rows?: readonly SubjectRowLike[]): string {
  const id = subjectIdentityKey(subject, rows) ?? subject;
  // provider 行优先（custom id 只有这里认识）；miss 再落编译期 builtin 快照。
  const matchedRow = rows?.find((r) => r.id === id);
  const fromRows = matchedRow
    ? matchedRow.configurationStatus === 'general-fallback'
      ? `${matchedRow.displayName} · 通用模式`
      : displayLabel(matchedRow)
    : undefined;
  return fromRows ?? subjectProfiles[id]?.displayName ?? subject;
}

// YUK-598（review-757 P3-2）：双定义收敛——单源 = profile-schema 的
// Pick<SubjectProfile,...>（RenderConfig 恰三键，结构等价）；re-export 保住
// 既有 '@/ui/lib/subject' import 面。
import type { SlimSubjectProfile } from '@/subjects/profile-schema';
export type { SlimSubjectProfile };

export interface SubjectRenderModel extends SlimSubjectProfile {
  contentClassName: string;
  contentStyle: CSSProperties;
}

export interface SubjectContentProps {
  className: string;
  style: CSSProperties;
  'data-subject': string;
  'data-notation'?: string;
}

export interface SubjectContentOptions {
  className?: string;
  style?: CSSProperties;
}

// YUK (wenyan deprotagonist): the UI slim-profile fallback is subject-NEUTRAL
// (`general`, system font), mirroring the backend default. Content with no
// reachable subject profile renders in the plain sans/system font instead of
// inheriting wenyan's serif-CJK (the serif stack is reserved for genuine
// classical-Chinese passages per the design redraw brief, not generic content).
export const DEFAULT_SLIM_SUBJECT_PROFILE: SlimSubjectProfile = {
  id: 'general',
  displayName: '通用',
  renderConfig: {
    font_family: 'system',
    notation: null,
    code_highlight: null,
  },
};

function sanitizeClassSegment(value: string): string {
  const out = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'unknown';
}

function fontMapping(fontFamily: string): { classSuffix: string; fontFamily: string } {
  switch (fontFamily) {
    case 'serif-cjk':
      return { classSuffix: 'serif-cjk', fontFamily: 'var(--font-wenyan)' };
    case 'system':
      return { classSuffix: 'system', fontFamily: 'var(--font-sans)' };
    default:
      return { classSuffix: 'unknown', fontFamily: 'var(--font-sans)' };
  }
}

function normalizeProfile(profile?: SlimSubjectProfile | null): SlimSubjectProfile {
  if (!profile) return DEFAULT_SLIM_SUBJECT_PROFILE;
  return {
    id: profile.id || DEFAULT_SLIM_SUBJECT_PROFILE.id,
    displayName: profile.displayName || DEFAULT_SLIM_SUBJECT_PROFILE.displayName,
    renderConfig: {
      font_family:
        profile.renderConfig.font_family || DEFAULT_SLIM_SUBJECT_PROFILE.renderConfig.font_family,
      notation: profile.renderConfig.notation ?? null,
      code_highlight: profile.renderConfig.code_highlight ?? null,
    },
  };
}

export function resolveSubjectRenderModel(profile?: SlimSubjectProfile | null): SubjectRenderModel {
  const normalized = normalizeProfile(profile);
  const font = fontMapping(normalized.renderConfig.font_family);
  const classes = [
    'subject-content',
    `subject-content--subject-${sanitizeClassSegment(normalized.id)}`,
    `subject-content--font-${font.classSuffix}`,
  ];

  if (normalized.renderConfig.notation) {
    classes.push(
      `subject-content--notation-${sanitizeClassSegment(normalized.renderConfig.notation)}`,
    );
  }

  return {
    ...normalized,
    contentClassName: classes.join(' '),
    contentStyle: {
      fontFamily: font.fontFamily,
    },
  };
}

function isRenderModel(
  profileOrModel: SlimSubjectProfile | SubjectRenderModel | null | undefined,
): profileOrModel is SubjectRenderModel {
  return (
    profileOrModel !== null &&
    profileOrModel !== undefined &&
    'contentClassName' in profileOrModel &&
    typeof profileOrModel.contentClassName === 'string'
  );
}

export function subjectContentProps(
  profileOrModel?: SlimSubjectProfile | SubjectRenderModel | null,
  options: SubjectContentOptions = {},
): SubjectContentProps {
  const model = isRenderModel(profileOrModel)
    ? profileOrModel
    : resolveSubjectRenderModel(profileOrModel);
  const className = [model.contentClassName, options.className].filter(Boolean).join(' ');
  return {
    className,
    style: { ...options.style, ...model.contentStyle },
    'data-subject': model.id,
    ...(model.renderConfig.notation ? { 'data-notation': model.renderConfig.notation } : {}),
  };
}

// YUK (wenyan deprotagonist): resolve a knowledge node's `effective_domain`
// (the only subject signal the knowledge-tree wire carries) into a slim render
// model, so UI render points can drive font/class from the node's REAL subject
// instead of hardcoding `className="wenyan"`. A null / unknown domain folds to
// the neutral default profile (system font) via the registry resolver — the
// serif-CJK `--font-wenyan` stack only lands for genuine classical-Chinese
// (wenyan) content. The registry resolve chain is pure data (no server-only
// deps), so it is safe to bundle into the SPA.
export function resolveSubjectRenderModelForDomain(domain?: string | null): SubjectRenderModel {
  return resolveSubjectRenderModel(toSlimSubjectProfile(resolveSubjectProfile(domain)));
}

// Convenience wrapper: domain string → ready-to-spread content props.
export function subjectContentPropsForDomain(
  domain?: string | null,
  options: SubjectContentOptions = {},
): SubjectContentProps {
  return subjectContentProps(resolveSubjectRenderModelForDomain(domain), options);
}
