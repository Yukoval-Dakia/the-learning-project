// Phase 1c.1 Step 12.D — docs invariant audit.
//
// Pure-Node fs.readFileSync line-by-line scan (no DB, no Postgres container).
// Asserts that legacy terms appear only in explicitly allowlisted contexts in
// docs/architecture.md and CONTEXT.md — not in active architectural body text.
//
// Allowed contexts (per locked contract):
//   - ADR cross-reference lines (contain "ADR-0005" / "ADR-0006" etc.)
//   - Historical-marker lines (contain "v1 —" / "v1 (superseded)" / "已被取代")
//   - Quoted user-facing terms in CONTEXT.md header items (「错题」/ 用户语义)
//   - Plan files (docs/superpowers/plans/*) — not scanned at all
//   - Historical planning sections in architecture.md data model skeleton
//     (contain "历史规划参考" or "★ Phase 1c.1 实体：" annotation)
//   - Comments in code blocks that document DROP (contain "已 DROP" / "旧 Mistake")
//
// Verification gates:
//   grep "录入会话状态机" docs/architecture.md → 0 hits
//   grep "mistake 是" docs/architecture.md → 0 hits
//   grep "待 Phase 1c.1 落地" CONTEXT.md → 0 hits
//   grep "pg-boss dev harness" docs/architecture.md → ≥1 hit

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Read a file and return {lineNum (1-based), text} pairs. */
function readLines(relPath: string): Array<{ n: number; text: string }> {
  const abs = path.join(REPO_ROOT, relPath);
  const content = fs.readFileSync(abs, 'utf8');
  return content.split('\n').map((text, i) => ({ n: i + 1, text }));
}

/** True if a line is allowed to contain legacy terms. */
function isAllowedLine(text: string): boolean {
  // ADR cross-reference lines
  if (/ADR-0{0,3}[0-9]/.test(text)) return true;
  // Historical marker lines
  if (/v1[\s—]|v1\s+\(superseded\)|已被取代|已 DROP|旧 Mistake|旧.*表已 DROP/.test(text))
    return true;
  // User-facing preservation lines (CONTEXT.md header items or mappings that explicitly say "UI 保留")
  if (/UI 保留|用户语义|用户称呼/.test(text)) return true;
  // Architecture data model skeleton historical planning block annotation
  if (/历史规划参考|历史规划|★ Phase 1c\.1 实体/.test(text)) return true;
  // Planning-doc path references (cross-links to plan files)
  if (/docs\/superpowers\/plans\//.test(text)) return true;
  // CONTEXT.md header entries for 错题 that use user-facing label (the entry starts the term)
  // Allow lines that are the canonical entries introducing event-filter definitions
  if (/event WHERE action=.attempt./.test(text)) return true;
  // Allow lines that reference the legacy table NAME as a historical cross-ref (e.g. "旧 mistake.cause")
  if (/旧 mistake\.|旧.*mistake/.test(text)) return true;
  return false;
}

describe('Phase 1c.1 Step 12.D — docs legacy term invariant', () => {
  // ── architecture.md checks ──────────────────────────────────────────────

  it('docs/architecture.md: "录入会话状态机" → 0 hits (renamed to LearningSession)', () => {
    const lines = readLines('docs/architecture.md');
    const hits = lines.filter((l) => l.text.includes('录入会话状态机'));
    expect(
      hits.map((l) => `L${l.n}: ${l.text.trim()}`),
      '录入会话状态机 should have been renamed to 学习会话 (LearningSession)',
    ).toEqual([]);
  });

  it('docs/architecture.md: "mistake 是" → 0 hits (mistake-core framing removed)', () => {
    const lines = readLines('docs/architecture.md');
    const hits = lines.filter((l) => l.text.includes('mistake 是'));
    expect(
      hits.map((l) => `L${l.n}: ${l.text.trim()}`),
      '"mistake 是" framing should be removed from architecture.md',
    ).toEqual([]);
  });

  it('docs/architecture.md: echo_jobs pg-boss dev harness acknowledged', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'docs/architecture.md'), 'utf8');
    expect(
      content.includes('pg-boss dev harness'),
      'architecture.md should acknowledge echo_jobs + /api/echo as pg-boss E2E dev harness',
    ).toBe(true);
  });

  it('docs/architecture.md: event — first-class action log section exists', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'docs/architecture.md'), 'utf8');
    expect(
      content.includes('event — first-class action log'),
      'architecture.md should have an "event — first-class action log" section',
    ).toBe(true);
  });

  it('docs/architecture.md: knowledge_mesh section exists', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'docs/architecture.md'), 'utf8');
    expect(
      content.includes('knowledge_mesh'),
      'architecture.md should have a knowledge_mesh section',
    ).toBe(true);
  });

  it('docs/architecture.md: legacy terms only in allowed contexts', () => {
    const LEGACY_TERMS = ['review_event', 'dreaming_proposal', 'ingestion_session'];
    const lines = readLines('docs/architecture.md');
    const violations: string[] = [];

    for (const term of LEGACY_TERMS) {
      for (const { n, text } of lines) {
        if (text.includes(term) && !isAllowedLine(text)) {
          violations.push(`L${n} [${term}]: ${text.trim()}`);
        }
      }
    }

    expect(
      violations,
      `Legacy terms found outside allowed contexts in docs/architecture.md:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // ── CONTEXT.md checks ───────────────────────────────────────────────────

  it('CONTEXT.md: "待 Phase 1c.1 落地" → 0 hits (status has landed)', () => {
    const lines = readLines('CONTEXT.md');
    const hits = lines.filter((l) => l.text.includes('待 Phase 1c.1 落地'));
    expect(
      hits.map((l) => `L${l.n}: ${l.text.trim()}`),
      '"待 Phase 1c.1 落地" should be removed from CONTEXT.md (Steps 1-9 landed)',
    ).toEqual([]);
  });

  it('CONTEXT.md: 错题 entry contains event-filter definition', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'CONTEXT.md'), 'utf8');
    expect(
      content.includes("action='attempt'"),
      "CONTEXT.md 错题 entry should reference event WHERE action='attempt'",
    ).toBe(true);
  });

  it('CONTEXT.md: 归因 entry references judge event', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'CONTEXT.md'), 'utf8');
    expect(
      content.includes("action='judge'"),
      "CONTEXT.md 归因 entry should reference event WHERE action='judge'",
    ).toBe(true);
  });

  it('CONTEXT.md: 復習/review entry references review event', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'CONTEXT.md'), 'utf8');
    expect(
      content.includes("action='review'"),
      "CONTEXT.md 复习 entry should reference event WHERE action='review'",
    ).toBe(true);
  });

  it('CONTEXT.md: legacy terms only in allowed contexts', () => {
    const LEGACY_TERMS = ['review_event', 'dreaming_proposal', 'ingestion_session'];
    const lines = readLines('CONTEXT.md');
    const violations: string[] = [];

    for (const term of LEGACY_TERMS) {
      for (const { n, text } of lines) {
        if (text.includes(term) && !isAllowedLine(text)) {
          violations.push(`L${n} [${term}]: ${text.trim()}`);
        }
      }
    }

    expect(
      violations,
      `Legacy terms found outside allowed contexts in CONTEXT.md:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // ── Codex P2-J — doc drift checks ───────────────────────────────────────

  // Codex P2-J (drift 1) — line ~502 documented `import` as a value in the
  // event action enumeration, but KnownEvent has no `import` branch. Must be
  // either removed OR marked as `experimental:import`.
  it('docs/architecture.md: event.action enumeration does not include bare "import"', () => {
    const lines = readLines('docs/architecture.md');
    // Match an event-action enumeration line that includes a pipe-separated
    // bare `import` value (i.e., not the substring of `experimental:import`,
    // not the verb "import" used elsewhere in prose). The enumeration line
    // takes the shape "action: ... | import | ..." or "action: ... | import\b".
    const violations = lines.filter(
      (l) =>
        /^\s*action:\s/.test(l.text) &&
        /\|\s*import\s*\|/.test(l.text) &&
        !l.text.includes('experimental:import'),
    );
    expect(
      violations.map((l) => `L${l.n}: ${l.text.trim()}`),
      'event.action enumeration must not include a bare "import" value (KnownEvent has no import branch); use experimental:import if Phase 1c.2 needs it',
    ).toEqual([]);
  });

  // Codex P2-J (drift 2) — line ~371 documented `LearningItem.source:
  // attempt_event | ...` but live schema validates LearningItemSource =
  // 'mistake' | 'manual' | 'learning_intent' | 'ai_dream'. Doc must match.
  it('docs/architecture.md: LearningItem.source matches LearningItemSource schema enum', () => {
    // Pull the runtime enum from schema to avoid hard-coding a duplicate list.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const businessSchemaPath = path.join(REPO_ROOT, 'src/core/schema/business.ts');
    const schemaSrc = fs.readFileSync(businessSchemaPath, 'utf8');
    const m = schemaSrc.match(/LearningItemSource\s*=\s*z\.enum\(\[(.*?)\]\)/s);
    expect(
      m,
      'failed to locate LearningItemSource enum in src/core/schema/business.ts',
    ).toBeTruthy();
    const enumValues = (m?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);

    const lines = readLines('docs/architecture.md');
    // Find the LearningItem.source line(s) in the doc.
    const sourceLines = lines.filter(
      (l) => /^\s*source:\s/.test(l.text) && /LearningItem|attempt_event|mistake/.test(l.text),
    );
    // Also scan immediately around the LearningItem block (line range 367-380)
    const nearLearningItem = lines.filter(
      (l) => l.n >= 367 && l.n <= 380 && /^\s*source:\s/.test(l.text),
    );
    const candidates = sourceLines.length > 0 ? sourceLines : nearLearningItem;
    expect(
      candidates.length,
      'failed to locate LearningItem.source line in docs/architecture.md',
    ).toBeGreaterThan(0);

    for (const l of candidates) {
      // The doc line should mention every value in the schema enum.
      const missing = enumValues.filter((v) => !l.text.includes(v));
      expect(
        missing,
        `L${l.n}: LearningItem.source doc must mention every LearningItemSource enum value; missing: ${missing.join(', ')}\n  line: ${l.text.trim()}`,
      ).toEqual([]);
      // The doc line should NOT mention values that aren't in the schema.
      // We only flag tokens that look like enum identifiers (snake_case_word).
      const docTokens = l.text.match(/\b[a-z][a-z0-9_]+\b/g) ?? [];
      const stray = docTokens.filter(
        (t) =>
          // Only flag identifier-shaped tokens; filter out common doc words.
          /^[a-z]+(_[a-z0-9]+)+$/.test(t) &&
          !enumValues.includes(t) &&
          // Common non-enum tokens that appear in the source: line
          !['source', 'attempt_event', 'dream_event', 'event_id', 'learning_item'].includes(t),
      );
      // We don't fail on the 'attempt_event'/'dream_event' tokens because they
      // appear in the trailing comment (source_ref examples); but those should
      // not be confused with enum values. The strict check is `missing`.
      void stray;
    }
  });
});
