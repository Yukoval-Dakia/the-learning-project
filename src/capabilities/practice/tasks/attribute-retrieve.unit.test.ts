// YUK-462 / YUK-465 — cause-attribution L1 retriever (stage 1). PURE: no LLM,
// no DB, no embedding. Migrated out of attribute.db.test.ts into the unit
// partition (YUK-465 #3) because the retriever is a deterministic pure function
// that never touched Postgres — the testcontainer harness was pure overhead.
// (`AttributionInput` is a TYPE-only import from ./attribute, so the DB-tainted
// module graph behind it is erased at compile time — this file stays no-DB.)
//
// Coverage:
//   - small-vocab identity passthrough (behavior-equivalence short-circuit).
//   - SHIPPED-PROFILE INVARIANT guard (YUK-465 #3): every registered profile's
//     cause vocab <= K_SMALL, so the equivalence guarantee can't silently lapse
//     into the scorer path when someone bumps a profile's taxonomy.
//   - large-vocab scorer path (YUK-465 #1/#2): K_SMALL/K_SMALL+1 boundary,
//     <= K_MAX cap, single-char CJK token matching, exact-token (non-substring)
//     matching.

import { describe, expect, it } from 'vitest';
import { CauseCategoryId } from '@/core/schema/business';
import {
  type SubjectProfile,
  getDefaultSubjectRegistry,
  resolveSubjectProfile,
} from '@/subjects/profile';
import {
  K_MAX,
  K_SMALL,
  type MisconceptionCauseSource,
  misconceptionToCandidate,
  retrieveCauseCandidates,
} from './attribute-retrieve';
import { type AttributionInput, parseAttributionOutput } from './attribution';

const retrieveInput: AttributionInput = {
  prompt_md: '"之"在主谓之间的用法?',
  reference_md: '取消句子独立性',
  wrong_answer_md: '助词',
  knowledge_context: [{ id: 'k_xuci', name: '虚词', effective_domain: 'yuwen' }],
};

/** Build a synthetic profile with `n` placeholder cause categories, optionally
 *  giving one of them a label/description that should keyword-match the input. */
function synthProfile(
  n: number,
  opts?: { matchIndex?: number; matchLabel?: string; matchDescription?: string },
): SubjectProfile {
  const base = resolveSubjectProfile('yuwen');
  const categories = Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    label: opts && i === opts.matchIndex && opts.matchLabel ? opts.matchLabel : `占位错因${i}`,
    description: opts && i === opts.matchIndex ? opts.matchDescription : undefined,
  }));
  return { ...base, causeCategories: categories };
}

describe('retrieveCauseCandidates — small-vocab identity passthrough', () => {
  it('returns full vocab verbatim (same reference, no reordering) for small-vocab profiles', () => {
    // EQUIVALENCE CONTRACT: the candidate set handed to stage 2 is byte-identical
    // to what buildAttributionPrompt embeds inline. Every current profile vocab
    // (max 11) is <= K_SMALL (15), so the retriever is an identity passthrough.
    const yuwen = resolveSubjectProfile('yuwen');
    const math = resolveSubjectProfile('math');
    expect(yuwen.causeCategories.length).toBeLessThanOrEqual(K_SMALL);
    expect(math.causeCategories.length).toBeLessThanOrEqual(K_SMALL);
    // Identity (same array reference) — not just deep-equal — proves zero copy/reorder.
    expect(retrieveCauseCandidates(retrieveInput, yuwen)).toBe(yuwen.causeCategories);
    expect(retrieveCauseCandidates(retrieveInput, math)).toBe(math.causeCategories);
  });
});

describe('retrieveCauseCandidates — shipped-profile equivalence invariant (YUK-465 #3)', () => {
  // The behavior-equivalence short-circuit only holds while every shipped profile
  // stays <= K_SMALL. Pin that invariant here so bumping any profile's cause
  // vocab past K_SMALL fails LOUDLY instead of silently activating the dormant
  // large-vocab scorer path (which would change attribution behavior unnoticed).
  it('every registered subject profile has cause vocab <= K_SMALL', () => {
    const profiles = getDefaultSubjectRegistry().listProfiles();
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) {
      expect(
        profile.causeCategories.length,
        `profile '${profile.id}' cause vocab (${profile.causeCategories.length}) exceeds K_SMALL=${K_SMALL} — this silently activates the dormant large-vocab scorer path and breaks behavior-equivalence; harden + intentionally flip before shipping (YUK-465)`,
      ).toBeLessThanOrEqual(K_SMALL);
    }
  });
});

describe('retrieveCauseCandidates — large-vocab scorer path (YUK-465 #1/#2)', () => {
  it('K_SMALL boundary: len == K_SMALL still short-circuits to the SAME reference', () => {
    const profile = synthProfile(K_SMALL);
    expect(profile.causeCategories.length).toBe(K_SMALL);
    expect(retrieveCauseCandidates(retrieveInput, profile)).toBe(profile.causeCategories);
  });

  it('K_SMALL+1 boundary: activates the scorer path (no longer identity passthrough)', () => {
    const profile = synthProfile(K_SMALL + 1);
    const result = retrieveCauseCandidates(retrieveInput, profile);
    // Scorer path builds a NEW array (slice/map) — proves the short-circuit was bypassed.
    expect(result).not.toBe(profile.causeCategories);
    expect(result.length).toBeLessThanOrEqual(K_MAX);
  });

  it('truncates a large vocab to exactly K_MAX', () => {
    const result = retrieveCauseCandidates(retrieveInput, synthProfile(40));
    expect(result.length).toBe(K_MAX);
  });

  it('keeps an exact keyword match within the truncated top-K', () => {
    // '助词' appears verbatim in wrong_answer_md and is an exact ICU token of the
    // candidate label '助词误用'; the matching candidate must outrank the score-0
    // placeholders and survive truncation.
    const profile = synthProfile(20, {
      matchIndex: 7,
      matchLabel: '助词误用',
      matchDescription: '把动词误判为助词',
    });
    const result = retrieveCauseCandidates(retrieveInput, profile);
    expect(result.length).toBeLessThanOrEqual(K_MAX);
    expect(result.some((c) => c.id === 'c7')).toBe(true);
  });

  it('matches single-char CJK tokens (the old length>1 filter would have dropped them)', () => {
    // '之' is a single CJK char in prompt_md. A candidate whose label is the bare
    // char '之' must score and survive — the previous tokenizer dropped all
    // length-1 tokens, losing this match entirely.
    const profile = synthProfile(20, { matchIndex: 3, matchLabel: '之' });
    const result = retrieveCauseCandidates(retrieveInput, profile);
    expect(result.some((c) => c.id === 'c3')).toBe(true);
  });

  it('does NOT false-match on cross-boundary substrings (exact token-set, not includes)', () => {
    // '帮助词典' segments to ['帮助','词典']; the substring '助词' spans the
    // 帮|助词|典 boundary. The OLD substring scorer (`hay.includes('助词')`)
    // false-matched a '助词' candidate here; exact token-set intersection must NOT.
    const input: AttributionInput = {
      prompt_md: '帮助词典',
      reference_md: null,
      wrong_answer_md: '帮助词典',
      knowledge_context: [],
    };
    const base = resolveSubjectProfile('yuwen');
    // Declaration order: K_MAX zero-score placeholders, then a REAL exact-token
    // match ('词典'), then the cross-boundary-substring candidate ('助词').
    const categories = [
      ...Array.from({ length: K_MAX }, (_, i) => ({ id: `p${i}`, label: `无关错因${i}` })),
      { id: 'real', label: '词典' }, // exact token of '帮助词典' → scores 1
      { id: 'substr', label: '助词' }, // substring only → must score 0
    ];
    const profile: SubjectProfile = { ...base, causeCategories: categories };
    const result = retrieveCauseCandidates(input, profile);
    // The real exact-token match jumps the queue and survives truncation...
    expect(result.some((c) => c.id === 'real')).toBe(true);
    // ...while the substring-only candidate gains NO spurious point, stays at the
    // tail (score 0, declaration order), and is truncated out of the top-K.
    expect(result.some((c) => c.id === 'substr')).toBe(false);
  });
});

// ── YUK-1015 (454-A): misconception candidates ∪ vocab ───────────────────────
// Design §L1: retrieve candidates = vocab ∪ 已晋升误区节点. Misc ids are already
// `misc_<sha256-24>` (valid CauseCategoryId); a rerank picking one must SURVIVE
// post-LLM validation — which the caller achieves by extending the validation
// vocab with the same candidates (see failure-learning-attribution.ts).

const miscSource: MisconceptionCauseSource = {
  id: 'misc_a1b2c3d4e5f6a7b8c9d0e1f2',
  title: '「之」作助词的整体性误判',
  reasoning: '三次把主谓间「之」按普通助词处理，忽略其取消独立性的句法作用',
};

describe('misconceptionToCandidate — id mapping (YUK-1015)', () => {
  it('passes a well-formed misc_<hash> id through verbatim', () => {
    const candidate = misconceptionToCandidate(miscSource);
    expect(candidate.id).toBe(miscSource.id);
    expect(candidate.label).toBe(miscSource.title);
    expect(candidate.description).toBe(miscSource.reasoning);
    expect(candidate.source_pack).toEqual({ id: 'misconception', version: 'promoted' });
  });

  it('produced ids always satisfy CauseCategoryId (defensive sanitize + prefix)', () => {
    // The promote writer mints misc_<sha256-24> today; if a future source emits
    // another shape the mapper must still yield a schema-valid namespaced id.
    for (const id of ['misc_a1b2c3', 'plainId', 'misc:X-Y', '9bad', 'UPPER']) {
      const candidate = misconceptionToCandidate({ ...miscSource, id });
      expect(
        CauseCategoryId.safeParse(candidate.id).success,
        `id '${id}' mapped to '${candidate.id}' — fails CauseCategoryId`,
      ).toBe(true);
      expect(candidate.id.startsWith('misc_')).toBe(true);
    }
  });

  it('omits description when reasoning is null', () => {
    const candidate = misconceptionToCandidate({ ...miscSource, reasoning: null });
    expect(candidate.description).toBeUndefined();
  });
});

describe('retrieveCauseCandidates — misc union (YUK-1015)', () => {
  it('small pool (vocab + misc <= K_SMALL) returns the whole union, vocab first', () => {
    const yuwen = resolveSubjectProfile('yuwen');
    const misc = misconceptionToCandidate(miscSource);
    const result = retrieveCauseCandidates(retrieveInput, yuwen, [misc]);
    expect(result.length).toBe(yuwen.causeCategories.length + 1);
    // Vocab order preserved verbatim; the misc candidate is appended AFTER it
    // (declaration order wins scorer ties).
    expect(result.slice(0, yuwen.causeCategories.length)).toEqual(yuwen.causeCategories);
    expect(result[result.length - 1]).toEqual(misc);
  });

  it('empty misc input still returns the SAME vocab reference (invariant intact)', () => {
    const yuwen = resolveSubjectProfile('yuwen');
    expect(retrieveCauseCandidates(retrieveInput, yuwen, [])).toBe(yuwen.causeCategories);
    expect(retrieveCauseCandidates(retrieveInput, yuwen)).toBe(yuwen.causeCategories);
  });

  it('misc candidates participate in the large-vocab scorer path', () => {
    // Pool > K_SMALL activates the dormant scorer; a misc whose label matches
    // the attempt text must outrank zero-score placeholders and survive top-K.
    const profile = synthProfile(K_SMALL + 1);
    const misc = misconceptionToCandidate({
      id: 'misc_ffffaaaa1111222233334444',
      title: '助词误用',
      reasoning: '把「之」误判为普通助词',
    });
    const result = retrieveCauseCandidates(retrieveInput, profile, [misc]);
    expect(result.length).toBeLessThanOrEqual(K_MAX);
    expect(result.some((c) => c.id === misc.id)).toBe(true);
  });
});

describe('misc candidate → attribution validation contract (YUK-1015)', () => {
  const rerankJson = (id: string, secondary: string[] = []) =>
    `{"primary_category":"${id}","secondary_categories":${JSON.stringify(
      secondary,
    )},"analysis_md":"把主谓间「之」按普通助词处理","confidence":0.8}`;

  it('misc id SURVIVES as primary when the validation vocab includes the candidate', () => {
    const yuwen = resolveSubjectProfile('yuwen');
    const misc = misconceptionToCandidate(miscSource);
    // Mirrors failure-learning-attribution.ts: validation profile = profile ∪ miscs.
    const extended: SubjectProfile = {
      ...yuwen,
      causeCategories: [...yuwen.causeCategories, misc],
    };
    const out = parseAttributionOutput(rerankJson(misc.id), extended);
    expect(out.primary_category).toBe(misc.id);
    // No meta_cause_prior declared on misc candidates → honest null.
    expect(out.meta_cause).toBeNull();
  });

  it('misc id CLAMPS to other without the extension — the silent-drop being prevented', () => {
    const yuwen = resolveSubjectProfile('yuwen');
    const out = parseAttributionOutput(rerankJson(miscSource.id), yuwen);
    expect(out.primary_category).toBe('other');
  });

  it('misc id survives in secondary_categories under the extended vocab', () => {
    const yuwen = resolveSubjectProfile('yuwen');
    const misc = misconceptionToCandidate(miscSource);
    const extended: SubjectProfile = {
      ...yuwen,
      causeCategories: [...yuwen.causeCategories, misc],
    };
    const out = parseAttributionOutput(rerankJson('concept', [misc.id]), extended);
    expect(out.primary_category).toBe('concept');
    expect(out.secondary_categories).toEqual([misc.id]);
  });

  it('a hallucinated id outside BOTH vocab and miscs still clamps (contract preserved)', () => {
    const yuwen = resolveSubjectProfile('yuwen');
    const misc = misconceptionToCandidate(miscSource);
    const extended: SubjectProfile = {
      ...yuwen,
      causeCategories: [...yuwen.causeCategories, misc],
    };
    const out = parseAttributionOutput(rerankJson('bogus_id'), extended);
    expect(out.primary_category).toBe('other');
  });
});
