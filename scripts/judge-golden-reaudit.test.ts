// YUK-573 (leg A) — judge-golden replay gate: every committed fixture must be
// CLEAN under the CURRENT judge normalization pipeline, and the harness itself
// must expose (a) tampered expectations, (b) swallowed db touches, and (c)
// accelerator regressions as deterministic drift. Runs in the unit partition
// (scripts/**/*.test.ts): the replay is pure — db is a throwing-Proxy sentinel,
// the LLM is a frozen-text stub, images come from an injected stub fetcher.
import { describe, expect, it } from 'vitest';

import {
  DB_TOUCH_MARKER,
  type JudgeGoldenCase,
  UNSUPPORTED_DISCRIMINATOR_KEYS,
  listGoldenFixtureFiles,
  loadGoldenFixture,
  makeDbSentinel,
  parseGoldenFixture,
  reauditJudgeGolden,
  reauditJudgeGoldenCase,
} from './judge-golden-reaudit';

describe('judge-golden reaudit (leg A)', () => {
  it('has at least one committed fixture file', () => {
    expect(listGoldenFixtureFiles().length).toBeGreaterThan(0);
  });

  it('all committed fixtures replay CLEAN', async () => {
    for (const file of listGoldenFixtureFiles()) {
      const fixture = loadGoldenFixture(file);
      expect(fixture.cases.length).toBeGreaterThan(0);
      const result = await reauditJudgeGolden(fixture);
      expect(result.checked).toBe(fixture.cases.length);
      // Rich failure message: which file / case / diff.
      expect(result.drifted.map((d) => `${file} :: ${d.id} :: ${d.diffs.join(' | ')}`)).toEqual([]);
    }
  });

  it('a tampered expected surfaces as drift', async () => {
    const fixture = loadGoldenFixture(listGoldenFixtureFiles()[0] as string);
    const tampered = structuredClone(fixture);
    const first = tampered.cases[0] as JudgeGoldenCase;
    first.expected.coarse_outcome =
      first.expected.coarse_outcome === 'correct' ? 'incorrect' : 'correct';
    const result = await reauditJudgeGolden(tampered);
    expect(result.drifted.map((d) => d.id)).toContain(first.id);
  });

  it('db sentinel throws on string-keyed API access with the marker', () => {
    const db = makeDbSentinel() as unknown as Record<string, unknown>;
    expect(() => db.select).toThrowError(new RegExp(DB_TOUCH_MARKER));
    // Engine-internal symbol reads stay benign (pretty-format probes these).
    expect((db as unknown as Record<symbol, unknown>)[Symbol.toStringTag]).toBeUndefined();
  });

  it('a swallowed db touch surfaces as deterministic drift (MF6 exposure mechanism)', async () => {
    // Take an image-bearing vision case and FORCE the default image-fetch path
    // (no injected stub): the runner falls into defaultImageFetch → R2/db →
    // throw → swallowed to 'image fetch failed' unsupported. The harness must
    // report drift (outcome mismatch vs the fixture's real verdict) — never a
    // silent pass.
    const steps = loadGoldenFixture('steps.json');
    const visionCase = steps.cases.find((c) => (c.student_image_refs ?? []).length > 0);
    expect(visionCase).toBeDefined();
    const diffs = await reauditJudgeGoldenCase(visionCase as JudgeGoldenCase, {
      omitImageFetchFn: true,
    });
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.join(' | ')).toContain('coarse_outcome');
  });

  it('llm_must_not_be_called violation surfaces as drift (accelerator regression guard)', async () => {
    const steps = loadGoldenFixture('steps.json');
    const accel = steps.cases.find((c) => c.llm_must_not_be_called === true);
    expect(accel).toBeDefined();
    // Break the accelerator precondition: an answer that matches no equivalent
    // forces the LLM path, so the frozen-stub gets called → explicit drift line.
    const broken = structuredClone(accel as JudgeGoldenCase);
    broken.answer_md = '绝不匹配的答案';
    const diffs = await reauditJudgeGoldenCase(broken);
    expect(diffs.join(' | ')).toContain('llm_must_not_be_called');
  });

  it('a malformed fixture fails loud at load time (Zod envelope — OCR review)', () => {
    const good = loadGoldenFixture(listGoldenFixtureFiles()[0] as string);
    // Wrong version literal → clear validation error, not a deep replay crash.
    const wrongVersion = { ...structuredClone(good), version: 2 };
    expect(() => parseGoldenFixture(wrongVersion)).toThrowError(/version/);
    // Unknown expected-key (typo'd assertion field) → strict schema rejects.
    const typoCase = structuredClone(good);
    (typoCase.cases[0] as unknown as { expected: Record<string, unknown> }).expected.corse_outcome =
      'correct';
    expect(() => parseGoldenFixture(typoCase)).toThrowError();
  });

  it('unsupported-expected cases pin discriminator evidence keys (复核吸收 1)', () => {
    // Structural guard on the fixtures themselves: every unsupported-expected
    // case must declare at least one evidence key the db-touch/LLM-throw
    // swallow paths ({error, …image_refs}) can NEVER produce — per-route real
    // keys: raw_text / validation_error (parse-fail), expected / got
    // (signal-mismatch invariant). A swallowed sentinel touch therefore cannot
    // false-pass any unsupported-expected case.
    for (const file of listGoldenFixtureFiles()) {
      for (const c of loadGoldenFixture(file).cases) {
        if (c.expected.coarse_outcome === 'unsupported') {
          const keys = c.expected.evidence_has_keys ?? [];
          expect(
            keys.some((k) => UNSUPPORTED_DISCRIMINATOR_KEYS.has(k)),
            `${file} :: ${c.id} must pin ≥1 discriminator key (got: ${keys.join(',') || 'none'})`,
          ).toBe(true);
        }
      }
    }
  });
});
