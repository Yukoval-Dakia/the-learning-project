// AGENT_META / SIGNAL_META — display vocabulary for the read-only "AI 观察"
// board (YUK-294). Keys are the REAL kind strings the backend writes, NOT the
// prototype's invented from/to keys (qverify/dreaming/planning/chat/...).
//
// Both source_task_kind and signal_kind are OPEN vocabularies: quiz_verify is
// the only writer on main today, but YUK-293 will add copilot/tagging/etc, and
// new signal_kind values appear without code changes. So every lookup MUST fall
// back gracefully for unknown keys — agentMeta()/signalMeta() below never throw
// and never render a blank chip (red-line: unknown key → label=raw kind,
// neutral tone, generic icon).

import type { LoomIconName } from '@/ui/primitives/LoomIcon';

// Signal tone drives the avatar tri-color, the signal chip, and the filter dot.
// Mirrors the FSRS/attribution palette via the .tone-chip-<tone> class layer.
export type SignalTone = 'hard' | 'info' | 'good' | 'coral' | 'neutral';

export interface AgentMeta {
  label: string;
  icon: LoomIconName;
}

export interface SignalMeta {
  label: string;
  tone: SignalTone;
}

// Keyed to real source_task_kind / target_agents values.
//   - source_task_kind: 'quiz_verify' is the only live writer on main; the
//     others (attribution/copilot/tagging) are near-term (YUK-293) or existing
//     read-side agents that may become writers.
//   - target_agents enum (notes.ts): 'dreaming' | 'maintenance' | 'coach'.
// All icon names are verified present in LoomIcon's ICONS table.
export const AGENT_META: Record<string, AgentMeta> = {
  // source_task_kind values
  quiz_verify: { label: '出题校验', icon: 'quiz' },
  attribution: { label: '错因归因', icon: 'mistakes' },
  copilot: { label: 'Copilot', icon: 'copilot' },
  tagging: { label: '打标', icon: 'tag' },
  // target_agents enum values
  dreaming: { label: '夜间推理', icon: 'moon' },
  maintenance: { label: '维护', icon: 'refresh' },
  coach: { label: '教练', icon: 'target' },
};

// signal_kind is an open vocabulary; these are the kinds the codebase emits or
// plans to emit. Tone reuses the FSRS/attribution palette.
export const SIGNAL_META: Record<string, SignalMeta> = {
  question_pool_gap: { label: '题池缺口', tone: 'hard' },
  coverage_thin: { label: '覆盖偏薄', tone: 'hard' },
  misconception: { label: '误解模式', tone: 'info' },
  pattern_hint: { label: '模式提示', tone: 'info' },
  quality: { label: '质量信号', tone: 'good' },
  offtopic: { label: '切题反复', tone: 'coral' },
};

// Fallback-safe lookups. Unknown kind → raw kind as label + neutral defaults,
// so an unrecognised agent/signal still renders (never blank, never throws).
export function agentMeta(kind: string): AgentMeta {
  return AGENT_META[kind] ?? { label: kind, icon: 'sparkle' };
}

export function signalMeta(kind: string): SignalMeta {
  return SIGNAL_META[kind] ?? { label: kind, tone: 'neutral' };
}
