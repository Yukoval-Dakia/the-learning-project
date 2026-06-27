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

import {
  type SubjectProfile,
  getDefaultSubjectRegistry,
  resolveSubjectProfile,
} from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import type { AttributionInput } from './attribute';
import { K_MAX, K_SMALL, retrieveCauseCandidates } from './attribute-retrieve';

const retrieveInput: AttributionInput = {
  prompt_md: '"之"在主谓之间的用法?',
  reference_md: '取消句子独立性',
  wrong_answer_md: '助词',
  knowledge_context: [{ id: 'k_xuci', name: '虚词', effective_domain: 'wenyan' }],
};

/** Build a synthetic profile with `n` placeholder cause categories, optionally
 *  giving one of them a label/description that should keyword-match the input. */
function synthProfile(
  n: number,
  opts?: { matchIndex?: number; matchLabel?: string; matchDescription?: string },
): SubjectProfile {
  const base = resolveSubjectProfile('wenyan');
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
    const wenyan = resolveSubjectProfile('wenyan');
    const math = resolveSubjectProfile('math');
    expect(wenyan.causeCategories.length).toBeLessThanOrEqual(K_SMALL);
    expect(math.causeCategories.length).toBeLessThanOrEqual(K_SMALL);
    // Identity (same array reference) — not just deep-equal — proves zero copy/reorder.
    expect(retrieveCauseCandidates(retrieveInput, wenyan)).toBe(wenyan.causeCategories);
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
    const base = resolveSubjectProfile('wenyan');
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
