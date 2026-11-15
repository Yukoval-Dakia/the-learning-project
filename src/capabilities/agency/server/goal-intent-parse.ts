// Deterministic goal-intent parse: pull a concrete goal title and a resolvable
// subject out of the learner's own words. No model decides this — the same
// words always produce the same parse, and an unknown subject stays unknown
// rather than being guessed into a whole-tree fallback.

import type { Db } from '@/db/client';
import { loadTreeSnapshot } from '@/kernel/read-models/knowledge-graph';
import {
  getKnownSubjects,
  resolveSelectableSubjectId,
} from '@/subjects/profile';
import { normalizeLearningIntentTopic } from './learning-intent-reuse';

export interface GoalIntentParse {
  /** Concrete goal title extracted from the words (「三角函数」). */
  title: string;
  /** Canonical subject id when one could be resolved deterministically. */
  subjectId: string | null;
}

/** Whether the words carry a recognizable goal-intent wrapper. */
export interface GoalTitleParse {
  /** Concrete goal title stripped of the intent frame. */
  title: string;
  /** True only when an explicit goal frame/verb was recognized (not bare text). */
  hasGoalFrame: boolean;
}

// Intent wrappers that frame a learning goal but are not themselves the goal.
// Matched greedily longest-first so 「我想把……学好」 strips before 「想学」.
const INTENT_WRAPPERS: readonly { pattern: RegExp; strip: (m: RegExpMatchArray) => string }[] = [
  {
    pattern:
      /^(?:我)?(?:想|想要|希望|打算|计划|要)?把(.+?)(?:学好|学会|学透|掌握好|掌握|练好|练熟|攻克|吃透|搞懂|弄懂|补习|补上|提高|提升)$/u,
    strip: (m) => m[1] ?? '',
  },
  {
    pattern: /^(?:我)?(?:想|想要|希望|打算|计划)?学(?:好|会|透|一学|下)?(.+?)$/u,
    strip: (m) => m[1] ?? '',
  },
  {
    pattern:
      /^(?:我)?(?:想|想要|希望|打算|计划|要)?(?:把|将|系统地|系统)?(.+?)(?:学好|学会|学透|掌握好|掌握|练好|练熟|攻克|吃透|搞懂|弄懂|补习|补上|提高|提升|学好它)$/u,
    strip: (m) => m[1] ?? '',
  },
  {
    // Verb-prefix forms: 想练熟X / 想掌握X / 想提高X — goal intent before the topic.
    pattern:
      /^(?:我)?(?:想|想要|希望|打算|计划|要)(?:把|将|系统地|系统)?(?:练熟|练好|掌握|掌握好|攻克|吃透|搞懂|弄懂|补习|补上|提高|提升)(.+?)$/u,
    strip: (m) => m[1] ?? '',
  },
  {
    // Bare-verb goal forms: 系统掌握X / 我要学好X / 要学好X.
    pattern:
      /^(?:我)?(?:要|想)?(?:系统(?:地)?|全面|彻底|深入)?(?:学好|学会|掌握|掌握好|攻克|吃透|搞懂|弄懂|练熟)(.+?)$/u,
    strip: (m) => m[1] ?? '',
  },
  {
    pattern: /^(?:我)?(?:的)?(?:目标|目的)(?:是|就是)?(.+?)$/u,
    strip: (m) => m[1] ?? '',
  },
];

/**
 * Strip goal-intent wrappers so the residue is the concrete topic the words
 * name. `hasGoalFrame` is true only when a real intent frame/verb matched —
 * bare topic text (「概率论」「帮我复习」) has no frame and stays off the goal
 * lane, so arbitrary strings are never silently treated as a goal.
 */
export function parseGoalTitle(verbatim: string): GoalTitleParse {
  const normalized = verbatim.trim().replace(/\s+/g, '');
  if (!normalized) return { title: '', hasGoalFrame: false };
  for (const { pattern, strip } of INTENT_WRAPPERS) {
    const match = normalized.match(pattern);
    if (match) {
      const inner = strip(match).trim();
      if (inner.length > 0 && inner !== normalized) {
        return { title: inner, hasGoalFrame: true };
      }
    }
  }
  return { title: normalized, hasGoalFrame: false };
}

/**
 * Deterministic subject resolution, in priority order. FIRST a registered
 * selectable subject named in the words wins (canonical + its aliases); only
 * when none matches does a live knowledge node whose name appears in the words
 * supply its effective domain as a secondary signal. Unknown stays null — the
 * caller surfaces an honest clarify rather than guessing a subject.
 */
export async function resolveGoalSubject(db: Db, words: string): Promise<string | null> {
  const normalized = normalizeLearningIntentTopic(words);
  if (!normalized) return null;

  // Priority 1 — a registered subject the words name wins. Deterministic and
  // the authority the user can actually select; beats any node-name guess.
  for (const subject of getKnownSubjects()) {
    const candidates = [subject.display_name, subject.id, ...(subject.aliases ?? [])];
    for (const candidate of candidates) {
      const key = normalizeLearningIntentTopic(candidate);
      if (key.length > 0 && normalized.includes(key)) {
        const resolved = resolveSelectableSubjectId(subject.id);
        if (resolved) return resolved;
      }
    }
  }

  // Priority 2 — a live node name inside the words supplies its effective
  // domain. Children do not store `domain` themselves (they inherit it from
  // their root), so a domain-column filter would wrongly exclude every
  // inherited node — exactly the 「三角函数」 case. Use the canonical subtree
  // reader `loadTreeSnapshot`, which already computes each node's effective
  // domain through the ancestor walk and is bounded by the established
  // snapshot cap (stable id order) — not an arbitrary name-length truncation
  // that could drop a short target name behind >500 longer node names.
  const nodes = await loadTreeSnapshot(db);
  let bestDomain: string | null = null;
  let bestLength = 0;
  for (const node of nodes) {
    const key = normalizeLearningIntentTopic(node.name ?? '');
    if (key.length < 2) continue; // avoid single-char over-matching
    if (key.length <= bestLength) continue;
    if (!normalized.includes(key)) continue;
    const effective = node.effective_domain;
    const resolved = effective ? resolveSelectableSubjectId(effective) : null;
    if (resolved) {
      bestDomain = resolved;
      bestLength = key.length;
    }
  }
  return bestDomain;
}

/**
 * Claim a goal intent only when the words carry a recognizable goal frame
 * (verb or intent wrapper). Bare topic text / arbitrary strings return null so
 * the caller stays on the atomic learning_item lane or reports a clarify —
 * never silently reclassifying non-goal input as a goal.
 */
export async function parseGoalIntent(db: Db, verbatim: string): Promise<GoalIntentParse | null> {
  const words = verbatim.trim();
  if (!words) return null;
  const parsed = parseGoalTitle(words);
  if (!parsed.hasGoalFrame || !parsed.title) return null;
  const subjectId = await resolveGoalSubject(db, parsed.title);
  return { title: parsed.title, subjectId };
}
