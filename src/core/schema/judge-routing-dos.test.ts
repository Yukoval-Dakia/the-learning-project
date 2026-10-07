// YUK-1224 (SCF-141) — the retired TRAILING_JUNK_RE
//   /(?:[\s。．.，,；;:、*]|\s*[（(]\s*(?:选项|正确答案)\s*[A-Z]{0,4}\s*[)）]?)+$/
// had an outer `+` whose alternatives overlapped on whitespace, so V8 explored an
// exponential number of partitions before concluding the end-anchored pattern does
// not match. `extractAnswerHead` runs it on learner-supplied answer content at the
// exact-judge sink, and the API allows 12 000 chars — one submission stalled the
// single Node event loop.
//
// This file pins the BOUNDED behavior. The child gets a hard timeout + SIGKILL: on
// the pre-fix code the call never returns, so `execFileSync` throws and the test
// fails RED instead of hanging the Vitest worker.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MODULE_URL = new URL('./judge-routing.ts', import.meta.url).href;
const CHILD_TIMEOUT_MS = 6_000;

function runAnswerHeadChild(repeats: number): { ms: number; len: number; matches: boolean } {
  const program = `
    const mod = await import(process.env.JUDGE_ROUTING_MODULE);
    const input = (' (选项A'.repeat(Number(process.env.JUDGE_ROUTING_REPEATS))).trim() + 'x';
    const started = process.hrtime.bigint();
    const out = mod.extractAnswerHead(input);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    process.stdout.write(JSON.stringify({ ms, len: input.length, matches: out === input.normalize('NFKC') }));
  `;
  const stdout = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', program],
    {
      cwd: REPO_ROOT,
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      env: {
        ...process.env,
        JUDGE_ROUTING_MODULE: MODULE_URL,
        JUDGE_ROUTING_REPEATS: String(repeats),
      },
    },
  );
  return JSON.parse(stdout) as { ms: number; len: number; matches: boolean };
}

describe('extractAnswerHead adversarial input is bounded (YUK-1224 / SCF-141)', () => {
  it('resolves the reported ~140-char trigger promptly', () => {
    const result = runAnswerHeadChild(24);
    expect(result.len).toBeGreaterThanOrEqual(110);
    // The string ends in a non-token 'x' ⇒ nothing is stripped (modulo NFKC).
    expect(result.matches).toBe(true);
    expect(result.ms).toBeLessThan(1_000);
  });

  it('stays bounded at the 12 000-char API response ceiling', () => {
    const result = runAnswerHeadChild(2_400);
    expect(result.len).toBeGreaterThanOrEqual(12_000);
    expect(result.matches).toBe(true);
    expect(result.ms).toBeLessThan(1_000);
  });
});
