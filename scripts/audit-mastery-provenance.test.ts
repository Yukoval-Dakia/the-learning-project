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
});
