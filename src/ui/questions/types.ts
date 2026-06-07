// YUK-288 题库 UI — client-side mirrors of the /api/questions reader shapes.
//
// These intentionally re-declare the JSON envelope the route serialises (rather
// than importing the server types) so the browser bundle never pulls a
// server-only module (@/db/client transitive). They must stay in sync with
// src/server/questions/{list,detail}.ts — the DB tests there are the contract.

export type SourceTierName = 'authentic' | 'sourced' | 'material' | 'generated';

export interface QuestionSourceTier {
  tier: 1 | 2 | 3 | 4;
  name: SourceTierName;
}

// One row of GET /api/questions (the flat list / expand-root path).
export interface QuestionListItem {
  id: string;
  kind: string;
  prompt_md: string; // truncated preview (server caps at 200 chars + ellipsis).
  source: string;
  source_tier: QuestionSourceTier;
  difficulty: number;
  visual_complexity: string | null;
  knowledge_ids: string[];
  root_question_id: string | null;
  variant_depth: number;
  parent_question_id: string | null;
  part_index: number | null;
  draft_status: string | null;
  created_at_sec: number;
}

export interface QuestionFamily {
  root_question_id: string;
  root_prompt_md: string;
  variant_count: number;
  max_variant_depth: number;
  member_ids: string[];
  representative: QuestionListItem;
}

export interface ListQuestionsResult {
  items: QuestionListItem[];
  families: QuestionFamily[] | null;
  total: number;
  truncated: boolean;
  computed_at_sec: number;
}

// ── detail (GET /api/questions/[id]) ──────────────────────────────────────────

export interface QuestionDetailLabel {
  id: string;
  name: string;
}

export interface QuestionDetailFamilyMember {
  id: string;
  variant_depth: number;
  kind: string;
  is_self: boolean;
}

export interface QuestionDetailFamily {
  root_question_id: string;
  members: QuestionDetailFamilyMember[];
  variant_count: number;
}

export interface QuestionDetailPart {
  id: string;
  kind: string;
  part_index: number;
  prompt_md: string;
  difficulty: number;
  draft_status: string | null;
}

export type MasteryDecayBucket = 'stale' | 'mild' | 'fresh' | 'untrained' | 'unknown';

export interface QuestionDetailPerKnowledge {
  knowledge_id: string;
  name: string | null;
  mastery: number | null;
  evidence_count: number;
  last_evidence_at_sec: number | null;
  decay_bucket: MasteryDecayBucket;
  due_at_sec: number | null;
}

export interface QuestionDetailScheduling {
  per_knowledge: QuestionDetailPerKnowledge[];
  aggregate_decay_bucket: MasteryDecayBucket;
  legacy_question_fsrs: { due_at_sec: number } | null;
}

export interface QuestionDetailBacklink {
  artifact_id: string;
  type: string;
  title: string;
  tool_kind: string | null;
  intent_source: string;
  generation_status: string;
  created_at_sec: number;
}

export interface QuestionDetailTimelineEntry {
  kind: 'attempt' | 'review';
  event_id: string;
  created_at_sec: number;
  outcome: string;
  duration_ms: number | null;
  cause?: { primary: string; confidence: number | null } | null;
  fsrs_rating?: 'again' | 'hard' | 'good';
}

export interface QuestionDetail {
  id: string;
  kind: string;
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  rubric_json: unknown;
  difficulty: number;
  source: string;
  source_ref: string | null;
  source_tier: QuestionSourceTier;
  visual_complexity: string | null;
  // `figures` is typed `unknown` at the API boundary (runtime: FigureRefT[]). The
  // UI narrows it defensively (see QuestionFigures) — never map it as a hard type.
  figures: unknown;
  image_refs: string[];
  variant_depth: number;
  root_question_id: string | null;
  parent_variant_id: string | null;
  parent_question_id: string | null;
  part_index: number | null;
  parts: QuestionDetailPart[];
  draft_status: string | null;
  knowledge_ids: string[];
  labels: QuestionDetailLabel[];
  family: QuestionDetailFamily;
  scheduling: QuestionDetailScheduling;
  backlinks: QuestionDetailBacklink[];
  backlinks_by_intent_source: Record<string, QuestionDetailBacklink[]>;
  timeline: QuestionDetailTimelineEntry[];
  metadata: Record<string, unknown> | null;
  created_at_sec: number;
  updated_at_sec: number;
  computed_at_sec: number;
}
