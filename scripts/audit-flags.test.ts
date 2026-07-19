import { describe, expect, it } from 'vitest';
import {
  FLAG_TOKEN_RE,
  type Ledger,
  computeLiteralVariance,
  reconcileFlags,
  scanFlagTokens,
  stripComments,
  validateLedgerEntry,
} from './audit-flags';

// 红线审查 wave F / A5 — audit:flags 的扫描器谓词 + 对账逻辑回归。
//
// 钉住：
//   (1) FLAG_TOKEN_RE 抓 `*_ENABLED` token，但末尾 word-boundary 排除 `DEFAULT_ENABLED_BY_KIND`。
//   (2) scanFlagTokens 在剥注释保字符串的源码上抓 token（字符串里的 flag 名算；注释里的不算）。
//   (3) reconcileFlags：代码有 ledger 无 → UNREGISTERED；ledger 有代码无 → STALE（per-file 反查）。
//   (4) env ledger 的 reader_marker 必须仍在活代码中，防 shared parseFlag 回退成 ad-hoc 比较。
//   (5) computeLiteralVariance 按 literals+大小写分组曝光约定不一致；polarity 不制造伪变体。

describe('FLAG_TOKEN_RE — matches *_ENABLED tokens, excludes DEFAULT_ENABLED_BY_KIND', () => {
  function tokens(s: string): string[] {
    FLAG_TOKEN_RE.lastIndex = 0;
    return [...s.matchAll(FLAG_TOKEN_RE)].map((m) => m[0]);
  }
  it('matches a plain flag identifier', () => {
    expect(tokens('const GRAPH_LAPLACIAN_ENABLED = false;')).toEqual(['GRAPH_LAPLACIAN_ENABLED']);
  });
  it('matches a flag name inside a string literal', () => {
    expect(tokens("env['WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED']")).toEqual([
      'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED',
    ]);
  });
  it('does NOT match DEFAULT_ENABLED out of DEFAULT_ENABLED_BY_KIND (trailing boundary)', () => {
    expect(tokens('const DEFAULT_ENABLED_BY_KIND = {};')).toEqual([]);
  });
  it('does NOT match a lowercase / mixed-case identifier', () => {
    expect(tokens('const isEnabled = true; const x_enabled = 1;')).toEqual([]);
  });
});

describe('stripComments — flag in comment excluded, flag in string kept', () => {
  it('drops a flag name that lives only in a line comment (renamed-away flag)', () => {
    const src = '// Renamed from PREREQ_PROPAGATION_ENABLED to disambiguate\nconst X = 1;';
    const code = stripComments(src);
    expect(code).not.toContain('PREREQ_PROPAGATION_ENABLED');
  });
  it('keeps a flag name inside a string constant', () => {
    const src = "export const FLAG = 'RESEARCH_MEETING_AGENT_ENABLED'; // env name";
    const code = stripComments(src);
    expect(code).toContain('RESEARCH_MEETING_AGENT_ENABLED');
    expect(code).not.toContain('env name');
  });
});

describe('scanFlagTokens — code-present flag set', () => {
  const shim =
    (content: Record<string, string>) =>
    (f: string): string | null =>
      f in content ? content[f] : null;

  it('collects flag tokens from identifiers and strings, skipping comments', () => {
    const content = {
      'a.ts': 'const THETA_GRID_ENABLED = false;',
      'b.ts': "if (process.env.PLACEMENT_PROBE_ENABLED === 'true') {}",
      'c.ts': '// mentions GRAPH_LAPLACIAN_ENABLED in a comment only',
    };
    const found = scanFlagTokens(['a.ts', 'b.ts', 'c.ts'], shim(content));
    expect([...found].sort()).toEqual(['PLACEMENT_PROBE_ENABLED', 'THETA_GRID_ENABLED']);
  });
});

describe('reconcileFlags — ledger ↔ code', () => {
  const envEntry = {
    kind: 'env' as const,
    literals: ['1'],
    case_insensitive: false,
    polarity: 'opt-in' as const,
    reader_marker: 'parseFlag(process.env.OK_ENABLED)',
    file: 'src/x.ts',
    notes: 'n',
  };

  it('flags a code-present flag missing from the ledger as UNREGISTERED', () => {
    const found = new Set(['NEW_THING_ENABLED']);
    const recon = reconcileFlags(found, {}, () => 'const NEW_THING_ENABLED = 1;');
    expect(recon.unregistered).toEqual(['NEW_THING_ENABLED']);
    expect(recon.ok).toBe(false);
  });

  it('marks a ledger flag whose declared file is gone as STALE (file-missing)', () => {
    const ledger: Ledger = { GONE_ENABLED: { ...envEntry, file: 'src/gone.ts' } };
    const recon = reconcileFlags(new Set(['GONE_ENABLED']), ledger, () => null);
    expect(recon.stale).toEqual([
      { name: 'GONE_ENABLED', file: 'src/gone.ts', problem: 'file-missing' },
    ]);
    expect(recon.ok).toBe(false);
  });

  it('marks a ledger flag no longer present in its declared file as STALE (name-missing)', () => {
    const ledger: Ledger = { RENAMED_ENABLED: { ...envEntry, file: 'src/x.ts' } };
    const recon = reconcileFlags(new Set(), ledger, () => 'file content without the flag');
    expect(recon.stale[0]).toEqual({
      name: 'RENAMED_ENABLED',
      file: 'src/x.ts',
      problem: 'name-missing',
    });
    expect(recon.ok).toBe(false);
  });

  it('does not let a comment-only flag name satisfy the per-file STALE check', () => {
    const ledger: Ledger = { OK_ENABLED: envEntry };
    const recon = reconcileFlags(
      new Set(),
      ledger,
      () =>
        '// OK_ENABLED and parseFlag(process.env.OK_ENABLED) were removed\nconst replacement = true;',
    );
    expect(recon.stale).toEqual([
      { name: 'OK_ENABLED', file: 'src/x.ts', problem: 'name-missing' },
    ]);
    expect(recon.readerDrift).toEqual([
      {
        name: 'OK_ENABLED',
        file: 'src/x.ts',
        marker: 'parseFlag(process.env.OK_ENABLED)',
      },
    ]);
    expect(recon.ok).toBe(false);
  });

  it('reports READER-DRIFT when a live flag regresses to direct literal comparison', () => {
    const ledger: Ledger = { OK_ENABLED: envEntry };
    const recon = reconcileFlags(
      new Set(['OK_ENABLED']),
      ledger,
      () => "const OK_ENABLED = process.env.OK_ENABLED === '1';",
    );
    expect(recon.stale).toHaveLength(0);
    expect(recon.readerDrift).toEqual([
      {
        name: 'OK_ENABLED',
        file: 'src/x.ts',
        marker: 'parseFlag(process.env.OK_ENABLED)',
      },
    ]);
    expect(recon.ok).toBe(false);
  });

  it('is ok when the ledger and code agree', () => {
    const ledger: Ledger = { OK_ENABLED: { ...envEntry, file: 'src/x.ts' } };
    const recon = reconcileFlags(
      new Set(['OK_ENABLED']),
      ledger,
      () => 'const OK_ENABLED = parseFlag(process.env.OK_ENABLED);',
    );
    expect(recon.unregistered).toHaveLength(0);
    expect(recon.stale).toHaveLength(0);
    expect(recon.readerDrift).toHaveLength(0);
    expect(recon.ok).toBe(true);
  });

  it('surfaces a malformed ledger entry as a ledger problem', () => {
    // env flag missing literals → invalid.
    const ledger = {
      BAD_ENABLED: {
        kind: 'env',
        case_insensitive: false,
        polarity: 'opt-in',
        file: 'src/x.ts',
        notes: 'n',
      },
    } as unknown as Ledger;
    const recon = reconcileFlags(new Set(['BAD_ENABLED']), ledger, () => 'BAD_ENABLED');
    expect(recon.ledgerProblems.some((p) => p.name === 'BAD_ENABLED')).toBe(true);
    expect(recon.ok).toBe(false);
  });
});

describe('validateLedgerEntry — shape contract', () => {
  it('accepts a well-formed env entry', () => {
    expect(
      validateLedgerEntry('X_ENABLED', {
        kind: 'env',
        literals: ['true'],
        case_insensitive: true,
        polarity: 'opt-in',
        reader_marker: 'parseFlag(process.env.X_ENABLED)',
        file: 'src/x.ts',
        notes: 'n',
      }),
    ).toHaveLength(0);
  });
  it('accepts a well-formed const entry', () => {
    expect(
      validateLedgerEntry('X_ENABLED', {
        kind: 'const',
        value: false,
        file: 'src/x.ts',
        notes: 'n',
      }),
    ).toHaveLength(0);
  });
  it('rejects an unknown kind', () => {
    const problems = validateLedgerEntry('X_ENABLED', {
      kind: 'weird',
      file: 'src/x.ts',
      notes: 'n',
    });
    expect(problems.some((p) => p.detail.includes('kind'))).toBe(true);
  });
  it('rejects an env entry with empty literals', () => {
    const problems = validateLedgerEntry('X_ENABLED', {
      kind: 'env',
      literals: [],
      case_insensitive: false,
      polarity: 'opt-in',
      reader_marker: 'parseFlag(process.env.X_ENABLED)',
      file: 'src/x.ts',
      notes: 'n',
    });
    expect(problems.some((p) => p.detail.includes('literals'))).toBe(true);
  });
  it('rejects an env entry with a missing or blank reader marker', () => {
    const problems = validateLedgerEntry('X_ENABLED', {
      kind: 'env',
      literals: ['true', '1'],
      case_insensitive: true,
      polarity: 'opt-in',
      reader_marker: '   ',
      file: 'src/x.ts',
      notes: 'n',
    });
    expect(problems.some((p) => p.detail.includes('reader_marker'))).toBe(true);
  });
});

describe('computeLiteralVariance — groups env flags by literal convention', () => {
  it('separates distinct conventions and excludes const flags', () => {
    const ledger: Ledger = {
      A_ENABLED: {
        kind: 'env',
        literals: ['1'],
        case_insensitive: false,
        polarity: 'opt-in',
        reader_marker: 'parseFlag(process.env.A_ENABLED)',
        file: 'a',
        notes: 'n',
      },
      B_ENABLED: {
        kind: 'env',
        literals: ['1'],
        case_insensitive: false,
        polarity: 'opt-in',
        reader_marker: 'parseFlag(process.env.B_ENABLED)',
        file: 'b',
        notes: 'n',
      },
      C_ENABLED: {
        kind: 'env',
        literals: ['true'],
        case_insensitive: true,
        polarity: 'opt-in',
        reader_marker: 'parseFlag(process.env.C_ENABLED)',
        file: 'c',
        notes: 'n',
      },
      D_ENABLED: { kind: 'const', value: true, file: 'd', notes: 'n' },
    };
    const variance = computeLiteralVariance(ledger);
    // two distinct env conventions; const excluded.
    expect(variance).toHaveLength(2);
    const oneGroup = variance.find((g) => g.signature.includes("literals='1'"));
    expect(oneGroup?.flags).toEqual(['A_ENABLED', 'B_ENABLED']);
    expect(variance.every((g) => !g.flags.includes('D_ENABLED'))).toBe(true);
  });

  it('keeps opt-in and opt-out flags in one group when their literal grammar matches', () => {
    const ledger: Ledger = {
      IN_ENABLED: {
        kind: 'env',
        literals: ['true', '1'],
        case_insensitive: true,
        polarity: 'opt-in',
        reader_marker: 'parseFlag(process.env.IN_ENABLED)',
        file: 'in',
        notes: 'n',
      },
      OUT_ENABLED: {
        kind: 'env',
        literals: ['true', '1'],
        case_insensitive: true,
        polarity: 'opt-out',
        reader_marker: 'parseFlag(process.env.OUT_ENABLED)',
        file: 'out',
        notes: 'n',
      },
    };
    expect(computeLiteralVariance(ledger)).toEqual([
      {
        signature: "literals='1'|'true' match=ci",
        flags: ['IN_ENABLED', 'OUT_ENABLED'],
      },
    ]);
  });
});
