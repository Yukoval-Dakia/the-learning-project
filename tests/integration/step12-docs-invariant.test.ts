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
});
