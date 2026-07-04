import { describe, expect, it } from 'vitest';
import {
  type Allowlist,
  computeProvenanceAudit,
  scanFile,
  validateAllowlistEntry,
} from './audit-mastery-provenance';

// YUK-559 / S2 — 借用 provenance 消费纪律审计的判据回归。
//
// 钉住三件事：
//   (1) scanFile：读 .mastery/.theta_hat 但无 guard token ⇒ 待标记；有 guard ⇒ 放行；
//       .mastery_lo / .theta_hat_raw 等派生字段不算 field-read（\b 边界）。
//   (2) computeProvenanceAudit：unguarded 且不在 allowlist ⇒ FLAGGED；allowlisted ⇒ 放行；
//       guarded / 无 field-read ⇒ 放行；文件缺失 ⇒ missing。
//   (3) validateAllowlistEntry：resolves_when 契约（kind/ref/expected_by + 过期）。

const TODAY = '2026-07-04';

describe('scanFile — field-read + guard detection', () => {
  it('reads .mastery / .theta_hat without a guard → unguarded field read', () => {
    const scan = scanFile('const m = proj.mastery; const t = proj.theta_hat;');
    expect(scan.readsField).toBe(true);
    expect(scan.guarded).toBe(false);
  });

  it('a guard token (evidence_count / isObserved / provenance) marks the file guarded', () => {
    expect(scanFile('if (proj.evidence_count >= 4) use(proj.mastery);').guarded).toBe(true);
    expect(scanFile('if (isObserved(proj)) use(proj.theta_hat);').guarded).toBe(true);
    expect(scanFile("if (proj.provenance === 'observed') use(proj.mastery);").guarded).toBe(true);
  });

  it('derived fields (.mastery_lo / .theta_hat_raw) are NOT counted as a field read', () => {
    const scan = scanFile('const lo = proj.mastery_lo; const raw = proj.theta_hat_raw;');
    expect(scan.readsField).toBe(false);
  });

  // C1 — a guard token inside a comment / string is NOT a code guard (post-strip detection).
  it('a guard token inside a line comment does NOT count as guarded', () => {
    const scan = scanFile('// evidence_count < 3 → 0.5 placeholder\nconst m = proj.mastery;');
    expect(scan.readsField).toBe(true);
    expect(scan.guarded).toBe(false);
  });

  it('a guard token inside a block comment does NOT count as guarded', () => {
    const scan = scanFile('/* isObserved gate lives elsewhere */ const t = proj.theta_hat;');
    expect(scan.readsField).toBe(true);
    expect(scan.guarded).toBe(false);
  });

  it('a guard token inside a string literal does NOT count as guarded', () => {
    const scan = scanFile('const label = "provenance"; const t = proj.theta_hat;');
    expect(scan.readsField).toBe(true);
    expect(scan.guarded).toBe(false);
  });

  it('a bare identifier / object-literal key (no dot, not isObserved) does NOT guard', () => {
    // `evidence_count:` as an object KEY and a bare `provenance` var are not code-shaped guards.
    expect(scanFile('const out = { evidence_count: 0 }; use(proj.mastery);').guarded).toBe(false);
    expect(scanFile('const provenance = 1; use(proj.theta_hat);').guarded).toBe(false);
  });

  it('a code-shaped guard (.evidence_count read / isObserved) still counts even beside a comment', () => {
    expect(
      scanFile('// evidence_count note\nif (proj.evidence_count) use(proj.mastery);').guarded,
    ).toBe(true);
  });
});

describe('computeProvenanceAudit — flag unguarded, non-allowlisted consumers', () => {
  const files: Record<string, string> = {
    'a.ts': 'const m = proj.mastery;', // unguarded field read
    'b.ts': 'if (proj.evidence_count) use(proj.theta_hat);', // guarded
    'c.ts': 'const lo = proj.mastery_lo;', // no field read
    'd.ts': 'const t = proj.theta_hat;', // unguarded field read (will be allowlisted)
  };
  const read = (f: string): string | null => files[f] ?? null;
  const tracked = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'missing.ts'];

  it('an unguarded field read NOT in the allowlist is FLAGGED', () => {
    const r = computeProvenanceAudit(tracked, read, {}, TODAY);
    expect(r.flagged).toContain('a.ts');
    expect(r.flagged).toContain('d.ts');
    expect(r.ok).toBe(false);
  });

  it('an allowlisted unguarded consumer passes (not flagged)', () => {
    const allowlist: Allowlist = {
      'd.ts': {
        reason: 'dark today',
        resolves_when: { kind: 'manual', ref: 'flip prereq', expected_by: '2027-06-30' },
      },
    };
    const r = computeProvenanceAudit(tracked, read, allowlist, TODAY);
    expect(r.flagged).toEqual(['a.ts']); // d.ts covered
    expect(r.verdicts.find((v) => v.file === 'd.ts')?.status).toBe('allowlisted');
  });

  it('guarded / no-field-read / missing consumers are never flagged', () => {
    const r = computeProvenanceAudit(tracked, read, {}, TODAY);
    expect(r.verdicts.find((v) => v.file === 'b.ts')?.status).toBe('guarded');
    expect(r.verdicts.find((v) => v.file === 'c.ts')?.status).toBe('no-field-read');
    expect(r.verdicts.find((v) => v.file === 'missing.ts')?.status).toBe('missing');
  });

  it('an allowlist entry for a now-guarded file is reported redundant (drift)', () => {
    const allowlist: Allowlist = {
      'b.ts': {
        reason: 'stale',
        resolves_when: { kind: 'manual', ref: 'x', expected_by: '2027-06-30' },
      },
    };
    const r = computeProvenanceAudit(tracked, read, allowlist, TODAY);
    expect(r.redundantAllowlist).toContain('b.ts');
    expect(r.ok).toBe(false);
  });

  // C2 — a MISSING tracked file (renamed/deleted) fails the audit (stale tracked-list contract).
  it('a missing tracked consumer is listed under missing and fails the audit', () => {
    const r = computeProvenanceAudit(tracked, read, {}, TODAY);
    expect(r.missing).toContain('missing.ts');
    expect(r.verdicts.find((v) => v.file === 'missing.ts')?.status).toBe('missing');
    expect(r.ok).toBe(false);
  });

  // C8⑤ — an allowlist entry for a no-field-read file is redundant (drift) → fails the audit.
  it('an allowlist entry for a no-field-read file is reported redundant', () => {
    const allowlist: Allowlist = {
      'c.ts': {
        reason: 'stale — reads no projection field',
        resolves_when: { kind: 'manual', ref: 'x', expected_by: '2027-06-30' },
      },
    };
    const r = computeProvenanceAudit(tracked, read, allowlist, TODAY);
    expect(r.redundantAllowlist).toContain('c.ts');
    expect(r.ok).toBe(false);
  });

  // PR #703 OCR round — an allowlist entry whose file is NOT tracked at all is dead
  // configuration (renamed consumer re-added under a new path) → redundant, fails audit.
  it('an orphaned allowlist entry (file not in tracked list) is reported redundant', () => {
    const allowlist: Allowlist = {
      'ghost.ts': {
        reason: 'orphaned — consumer was renamed',
        resolves_when: { kind: 'manual', ref: 'x', expected_by: '2027-06-30' },
      },
    };
    const r = computeProvenanceAudit(tracked, read, allowlist, TODAY);
    expect(r.redundantAllowlist).toContain('ghost.ts');
    expect(r.ok).toBe(false);
  });
});

describe('validateAllowlistEntry — resolves_when contract', () => {
  const good = {
    reason: 'r',
    resolves_when: { kind: 'manual' as const, ref: 'x', expected_by: '2027-06-30' },
  };

  it('a well-formed entry has no problems', () => {
    expect(validateAllowlistEntry('f.ts', good, TODAY)).toEqual([]);
  });

  it('an expired expected_by is flagged', () => {
    const expired = {
      ...good,
      resolves_when: { ...good.resolves_when, expected_by: '2020-01-01' },
    };
    expect(validateAllowlistEntry('f.ts', expired, TODAY).map((p) => p.problem)).toContain(
      'expired_expected_by',
    );
  });

  it('a bad kind / empty ref / malformed date are each flagged', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the negative test.
    const badKind: any = { ...good, resolves_when: { ...good.resolves_when, kind: 'bogus' } };
    expect(validateAllowlistEntry('f.ts', badKind, TODAY).map((p) => p.problem)).toContain(
      'invalid_kind',
    );
    const badRef = { ...good, resolves_when: { ...good.resolves_when, ref: '' } };
    expect(validateAllowlistEntry('f.ts', badRef, TODAY).map((p) => p.problem)).toContain(
      'invalid_ref',
    );
    const badDate = { ...good, resolves_when: { ...good.resolves_when, expected_by: '07/2027' } };
    expect(validateAllowlistEntry('f.ts', badDate, TODAY).map((p) => p.problem)).toContain(
      'invalid_expected_by',
    );
  });

  it('a null / non-object entry is reported (not a TypeError crash)', () => {
    // loadAllowlist casts JSON.parse output unsafely; a hand-edited allowlist may carry a null
    // or scalar value. The guard must report invalid_resolves_when instead of throwing.
    // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the negative test.
    expect(validateAllowlistEntry('f.ts', null as any, TODAY).map((p) => p.problem)).toEqual([
      'invalid_resolves_when',
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the negative test.
    expect(validateAllowlistEntry('f.ts', 'oops' as any, TODAY).map((p) => p.problem)).toEqual([
      'invalid_resolves_when',
    ]);
    // Arrays pass `typeof === 'object'` — the guard must reject them up front too
    // (PR #703 OCR round), not fall through to a misleading resolves_when message.
    // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the negative test.
    expect(validateAllowlistEntry('f.ts', [] as any, TODAY).map((p) => p.problem)).toEqual([
      'invalid_resolves_when',
    ]);
  });
});
