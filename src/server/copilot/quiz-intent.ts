// YUK-275 — free-text 求卷 (C 形态): 意图粗筛 (零 LLM) → 参数解析 (一次小 LLM)。
//
// This module is the service-side gate that lets a NATURAL-LANGUAGE quiz request
// ("选两篇高难度古诗词阅读给我") route to the existing runQuizSkill execution chain
// WITHOUT adding any tool to the Copilot surface (U6 防循环 red line). It has two
// stages:
//
//   1. detectQuizIntent(message): boolean — a pure keyword/正则 粗筛 (零解析税). It is a
//      fast shutter, NOT the only gate: even if it mis-fires, stage 2 can say "this is
//      not a quiz" and fall back to free-form (see is_quiz_request below).
//   2. resolveQuizIntent(...) — ONE small structured-output LLM call (QuizIntentParseTask)
//      that picks a knowledge_id from a candidate list (loadTreeSnapshot) and parses
//      count/difficulty_min/unit/kind. Hallucinated ids are filtered code-side.
//
// The four-state return (resolved / not_quiz / missing_knowledge / parse_failed) is the
// load-bearing contract chat.ts routes on (§3 Commit 3 / §5 降级合同):
//   - resolved          → run the quiz skill.
//   - not_quiz          → 粗筛 误伤; the parse said is_quiz_request:false → 回落 free-form.
//   - missing_knowledge → is_quiz_request:true but no valid knowledge_id → §5 追问 (NOT free-form).
//   - parse_failed      → the LLM call/parse threw → §5 追问 (NOT free-form).

import { z } from 'zod';

import type { Db } from '@/db/client';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { type KnowledgeNode, loadTreeSnapshot } from '@/server/knowledge/tree';
import type { SubjectProfile } from '@/subjects/profile';

// ── Stage 1: 粗筛 (零 LLM) ──────────────────────────────────────────────────────

// CRITIC FIX P1 (2026-06-07) — two-signal 粗筛, hardened against both 误伤 and 漏检.
// The naive greedy词集 (`来.*道` etc.) hijacked normal conversation ("我来看看这道题")
// into a quiz追问 loop. The contract below requires either (a) a STRONG quiz verb that
// can fire alone, or (b) a 求卷 verb co-occurring with a 题量/单位 quantifier, or (c)
// an English quiz/practice-set phrase. Validated by a table-driven fixture in the test
// (≥10命中 + ≥10误伤风险句); the owner判决句「选两篇高难度古诗词阅读给我」MUST be true and
// every 误伤 risk sentence MUST be false (the hard门槛 for this commit).

// A COUNT word: an Arabic numeral, or a Chinese numeral 一-十/两/几. 注意「这/那/某」是
// 指示词，绝不算 count —— 它们正是「这道题」误伤的根源，被排除在外。
const COUNT = '(?:\\d+|[一二三四五六七八九十两几])';

// (a) STRONG quiz verbs — any single match → true. These are unambiguous 出题 intents:
//   - 出题 / 出卷 / 出套题 / 出一套卷 (直接 出+[套份]?+题/卷)
//   - 出 + COUNT + 量词 (出几道古诗词题 / 出三道题 —— 出 + 数量 + 道/题/套/份/篇)
//   - 组卷 / 组一套卷 / 刷题 / 考考(我) / 考我 / 测验我
const STRONG_QUIZ_VERB = new RegExp(
  `出[套份]?[题卷]|出.{0,6}?${COUNT}\\s*[道题套份篇]|组卷|组一?[套份]卷|刷题|考考我?|考我|测验我`,
);

// (b) 求卷 verb — must CO-OCCUR with a 题量/单位 quantifier (avoids bare 练习/来 误伤).
const QUIZ_REQUEST_VERB = /给我?|来|做|练|选|搞|整/;
// 题量/单位: a count + 量词 (含篇/道阅读类), a 几+量词, or a 一套/一份. CRITIC FIX P1 —
// the 篇/道 + (阅读|题|诗|词|文) alternative MUST be preceded by a COUNT, otherwise a
// demonstrative「这道题」/「那道诗」hijacks normal conversation into a quiz request.
const QUANTITY_OR_UNIT = new RegExp(
  `${COUNT}\\s*[道题套份篇]|一[套份]|${COUNT}\\s*[篇道]\\s*.{0,6}(?:阅读|题|诗|词|文)`,
);

// (c) English quiz / practice-set phrases.
const ENGLISH_QUIZ = /\bquiz\b|\bpractice (set|paper)\b/i;

/**
 * 零-LLM 粗筛: does this message look like a request to ASSEMBLE a practice paper?
 *
 * Pure + table-testable. Returns true for strong 出题 verbs, OR a 求卷 verb paired with
 * a 题量/单位 quantifier, OR an English quiz/practice-set phrase. A false here means the
 * message is byte-for-byte routed to the free-form CopilotTask (零解析税). A true only
 * BUYS a parse call — stage 2 (is_quiz_request) is the真正的 semantic gate.
 */
export function detectQuizIntent(message: string): boolean {
  if (STRONG_QUIZ_VERB.test(message)) return true;
  if (QUIZ_REQUEST_VERB.test(message) && QUANTITY_OR_UNIT.test(message)) return true;
  if (ENGLISH_QUIZ.test(message)) return true;
  return false;
}

// ── Stage 2: 参数解析 (一次小 LLM) ──────────────────────────────────────────────

// CRITIC FIX P1 — is_quiz_request 逃生舱: the model first decides whether the message is
// REALLY a 求卷 (vs a 粗筛 误伤). false → code-side 回落 free-form; this is the深度兜底.
export const QuizIntentSchema = z.object({
  is_quiz_request: z.boolean(),
  knowledge_id: z.string().nullable(),
  count: z.number().int().min(1).max(20).nullable(),
  difficulty_min: z.number().int().min(1).max(5).nullable(),
  unit: z.enum(['题', '篇']).nullable(),
  kind: z.string().nullable(),
});
export type QuizIntent = z.infer<typeof QuizIntentSchema>;

/**
 * brace-slice + Zod parse for the QuizIntentParseTask raw text output (照
 * parseGoalScopeOutput). Throws on no-JSON / JSON.parse failure / schema mismatch; the
 * caller (resolveQuizIntent) catches and maps to status:'parse_failed'.
 */
export function parseQuizIntentOutput(text: string): QuizIntent {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseQuizIntentOutput: no JSON object found in text');
  }
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (e) {
    throw new Error(`parseQuizIntentOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return QuizIntentSchema.parse(json);
}

// ── 四态返回 (chat.ts routes on this) ────────────────────────────────────────────

export type ResolvedQuizIntent =
  | {
      status: 'resolved';
      knowledgeId: string;
      count: number | null;
      difficultyMin: number | null;
      unit: '题' | '篇' | null;
      kind: string | null;
    }
  // 粗筛 误伤被解析兜回 → 上层 回落 free-form (NOT 追问).
  | { status: 'not_quiz' }
  // is_quiz_request:true 但选不出 / 幻觉 id 被过滤 → 上层 §5 追问 (NOT free-form).
  | { status: 'missing_knowledge' }
  // 调用/解析异常 → 上层 §5 追问 (NOT free-form).
  | { status: 'parse_failed' };

// DI seam: defaults to the real loadTreeSnapshot; the unit test injects a fixture so
// the {}-stub db is never touched (与 chat.test.ts DI 范式一致).
type LoadTreeSnapshotFn = (db: Db) => Promise<KnowledgeNode[]>;

export interface ResolveQuizIntentParams {
  db: Db;
  userMessage: string;
  runTaskFn: TaskTextRunFn;
  subjectProfile?: SubjectProfile;
  env?: unknown;
}

export interface ResolveQuizIntentDeps {
  loadTreeSnapshotFn?: LoadTreeSnapshotFn;
}

/**
 * Resolve a 粗筛-positive message into a structured quiz intent (or one of the三 non-
 * resolved states). Loads the knowledge candidates, runs QuizIntentParseTask, then
 * applies the validNodeIds二次校验 (GoalScope `scope.ts` 同款) so a hallucinated
 * knowledge_id can never escape into the execution chain.
 *
 * Any failure (LLM outage / parse failure / schema mismatch) maps to 'parse_failed' —
 * the signal is propagated UP (NOT swallowed into a silent free-form fallback) so the
 * caller can §5 追问 instead of猜测.
 */
export async function resolveQuizIntent(
  params: ResolveQuizIntentParams,
  deps: ResolveQuizIntentDeps = {},
): Promise<ResolvedQuizIntent> {
  const loadTree = deps.loadTreeSnapshotFn ?? loadTreeSnapshot;
  try {
    const tree = await loadTree(params.db);
    const knowledgeCandidates = tree.map((n) => ({
      id: n.id,
      name: n.name,
      effective_domain: n.effective_domain,
    }));

    const input = {
      user_message: params.userMessage,
      knowledge_candidates: knowledgeCandidates,
    };

    const result = await params.runTaskFn('QuizIntentParseTask', input, {
      db: params.db,
      env: params.env,
      subjectProfile: params.subjectProfile,
    });
    const parsed = parseQuizIntentOutput(result.text);

    // 逃生舱: the model判定 this is not a 求卷 → 回落 free-form.
    if (!parsed.is_quiz_request) {
      return { status: 'not_quiz' };
    }

    // 二次校验: drop a hallucinated knowledge_id (not in the candidate set). A null or
    // out-of-set id → no valid 知识点 → 追问.
    const validNodeIds = new Set(tree.map((n) => n.id));
    if (parsed.knowledge_id === null || !validNodeIds.has(parsed.knowledge_id)) {
      return { status: 'missing_knowledge' };
    }

    return {
      status: 'resolved',
      knowledgeId: parsed.knowledge_id,
      count: parsed.count,
      difficultyMin: parsed.difficulty_min,
      unit: parsed.unit,
      kind: parsed.kind,
    };
  } catch (err) {
    // Propagate the failure signal (NOT a silent free-form fallback) so the caller §5
    // 追问 rather than猜测. The error is logged for evidence留痕.
    console.error('[resolveQuizIntent] parse failed; signalling parse_failed', err);
    return { status: 'parse_failed' };
  }
}

// ── §5 降级合同 (deterministic 追问文案, 无 LLM) ──────────────────────────────────

// CRITIC FIX P1 / §5 — the two追问 copies for the states that must NOT 回落 free-form.
// composite 库存 0 / 高难度空集 are handled by runQuizSkill's既有 pool_empty path (NOT
// re-stated here); these two are the parse-side gaps where there is no 知识点 to组卷 yet.
export const QUIZ_INTENT_MISSING_KNOWLEDGE_REPLY =
  '想给你出题，但没听清是哪个知识点。告诉我具体的知识点名（比如「古诗词阅读」），我就给你组卷。';
export const QUIZ_INTENT_PARSE_FAILED_REPLY =
  '想给你出题，但没太理解你的要求。换个说法告诉我：要哪个知识点、几道题、什么难度？';
