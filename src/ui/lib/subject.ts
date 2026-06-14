import { resolveSubjectProfile, toSlimSubjectProfile } from '@/subjects/profile';
import type { CSSProperties } from 'react';

export interface SlimSubjectProfile {
  id: string;
  displayName: string;
  renderConfig: {
    font_family: string;
    notation: string | null;
    code_highlight: string | null;
  };
}

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
