import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FLAG_TOKEN_RE,
  type Ledger,
  SCOPED_CONTROL_NAMES,
  computeLiteralVariance,
  reconcileFlags,
  scanFlagTokens,
  stripComments,
  validateLedgerEntry,
} from './audit-flags';
import ledgerJson from './audit-flags-ledger.json';

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
    // STALE is the root cause; do not duplicate it as READER-DRIFT.
    expect(recon.readerDrift).toHaveLength(0);
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

describe('YUK-1088 — non-ENABLED control coverage', () => {
  const controls = [
    'PROJECTION_IS_WRITER_ITEM_CALIBRATION',
    'HUB_SYNC_MODE',
    'SELECTION_POLICY',
    'MEMORY_RECONCILE_HANDOFF_MODE',
    'INTERVENTION_DISABLED_METHOD_IDS',
    'EXTRACT_OCR_ENGINE',
    'DOCX_CONVERT_ENGINE',
    'AI_PROVIDER_SESSION_ADMISSION_MODE',
    'AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON',
    'AI_PROVIDER_ATTEMPT_ADMISSION_MODE',
    'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON',
  ];

  it.each(controls)('detects a live %s independently of ledger membership', (name) => {
    const source = `// OLD_CONTROL_MODE is retired\nconst key = '${name}';\ngetConfig(key);`;
    const found = scanFlagTokens(['consumer.ts'], () => source);
    expect([...found]).toEqual([name]);
    expect(reconcileFlags(found, {}, () => source).unregistered).toEqual([name]);
  });

  it('does not expand a scoped control into comments, prefixes or unrelated knobs', () => {
    const source = `// HUB_SYNC_MODE\n/* SELECTION_POLICY */\nconst HUB_SYNC_MODE_DEFAULT = 'off';\nconst OTHER_MODE = 'not in the bounded census';`;
    expect([...scanFlagTokens(['consumer.ts'], () => source)]).toEqual([]);
  });
});

describe('YUK-1088 — real ledger mutation checks', () => {
  const ledger = ledgerJson as Ledger;
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const files = [...new Set(Object.values(ledger).map((entry) => entry.file))];
  const found = scanFlagTokens(files, read);

  it('reconciles every production reader and preserves boolean grammar distinctions', () => {
    expect(reconcileFlags(found, ledger, read).ok).toBe(true);
    expect(ledger.PROJECTION_IS_WRITER_ITEM_CALIBRATION).toMatchObject({
      kind: 'env',
      literals: ['1'],
      case_insensitive: false,
    });
    expect(ledger.PLACEMENT_PROBE_ENABLED).toMatchObject({
      kind: 'env',
      literals: ['true'],
      case_insensitive: false,
    });
    expect(ledger.HUB_SYNC_MODE).toMatchObject({
      kind: 'config',
      values: ['off', 'shadow', 'apply'],
    });
    expect(ledger.DOCX_CONVERT_ENGINE).toMatchObject({ kind: 'config', values: ['docker'] });
    expect(ledger).not.toHaveProperty('SKIP_BOSS_INGEST');
    expect(computeLiteralVariance(ledger).flatMap((group) => group.flags)).not.toContain(
      'HUB_SYNC_MODE',
    );
  });

  it.each(SCOPED_CONTROL_NAMES)('deleting the actual %s registration fails coverage', (name) => {
    const changed = { ...ledger };
    delete changed[name];
    const result = reconcileFlags(found, changed, read);
    expect(result.unregistered).toEqual([name]);
    expect(result.ok).toBe(false);
  });

  it.each(SCOPED_CONTROL_NAMES)('commenting the actual %s reader fails drift', (name) => {
    const entry = ledger[name];
    if (entry.kind === 'const') throw new Error('Expected a runtime reader');
    const changed = read(entry.file).replace(
      entry.reader_marker,
      `/* ${entry.reader_marker} */ unrelatedReader('${name}')`,
    );
    const result = reconcileFlags(found, ledger, (file) =>
      file === entry.file ? changed : read(file),
    );
    expect(result.readerDrift).toContainEqual({
      name,
      file: entry.file,
      marker: entry.reader_marker,
    });
    expect(result.ok).toBe(false);
  });

  it.each(SCOPED_CONTROL_NAMES)('retaining %s only in comments fails its source check', (name) => {
    const entry = ledger[name];
    // Wrap in a line-comment per line: a source file can already contain block comments.
    const commented = read(entry.file)
      .split('\n')
      .map((line) => `// ${line}`)
      .join('\n');
    const safelyCommented = reconcileFlags(found, ledger, (file) =>
      file === entry.file ? commented : read(file),
    );
    expect(safelyCommented.stale).toContainEqual({
      name,
      file: entry.file,
      problem: 'name-missing',
    });
    expect(safelyCommented.ok).toBe(false);
  });
});

describe('config control grammar contract', () => {
  const base = {
    kind: 'config',
    file: 'consumer.ts',
    notes: 'A live consumer',
    reader_marker: "getConfig('HUB_SYNC_MODE')",
  };
  it.each([
    { value_type: 'enum', values: ['off', 'shadow', 'apply'] },
    { value_type: 'csv' },
    { value_type: 'json' },
  ])('accepts non-boolean grammar %j', (shape) => {
    expect(validateLedgerEntry('HUB_SYNC_MODE', { ...base, ...shape })).toEqual([]);
  });
  it.each([
    { value_type: 'boolean' },
    { value_type: 'enum' },
    { value_type: 'enum', values: [] },
    { value_type: 'enum', values: ['off', 'off'] },
    { value_type: 'enum', values: [false] },
    { value_type: 'enum', values: [' '] },
    { value_type: 'csv', values: ['off'] },
    { value_type: 'json', literals: ['1'] },
    { value_type: 'csv', polarity: 'opt-in' },
    { value_type: 'enum', values: ['off'], case_insensitive: true },
    { value_type: 'json', reader_marker: '' },
  ])('rejects malformed or boolean-disguised control %j', (shape) => {
    expect(validateLedgerEntry('HUB_SYNC_MODE', { ...base, ...shape }).length).toBeGreaterThan(0);
  });
});
