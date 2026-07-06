import { describe, expect, it } from 'vitest';
import {
  type Allowlist,
  type SanctionedWriter,
  type StaleWriter,
  type WriteSite,
  computeFoldWriteAudit,
  findWriteSites,
  reverseCheckWriters,
  stripComments,
  validateAllowlistEntry,
} from './audit-fold-writes';

// 红线审查 wave F / A4 — audit:fold-writes 的扫描器谓词 + 对账逻辑回归。
//
// 钉住四件事：
//   (1) stripComments 剥注释保字符串、保 block-comment 里的换行（行号对齐），使注释里的
//       `.insert(knowledge_edge)` / `UPDATE knowledge` 不被当真写点。
//   (2) findWriteSites 抓 Drizzle 形 + raw-SQL 形，且 knowledge vs knowledge_edge 靠 `)` 消歧。
//   (3) reverseCheckWriters 抓 registry↔代码漂移（声明的写者文件/marker 消失）。
//   (4) computeFoldWriteAudit：未声明写者 → VIOLATION；stale 写者不算 sanctioned；allowlist 命中 →
//       ALLOWLISTED；死 allowlist 键 → redundant。

function writer(over: Partial<SanctionedWriter>): SanctionedWriter {
  return {
    table: 'knowledge',
    file: 'src/server/projections/knowledge.ts',
    marker: '.insert(knowledge)',
    role: 'throat',
    note: 'test',
    ...over,
  };
}

describe('stripComments — removes comments, keeps strings, preserves newlines', () => {
  it('strips a line comment (its content is not scanned)', () => {
    const src = 'const x = 1; // raw db.insert(knowledge_edge) is forbidden here\nconst y = 2;';
    const out = stripComments(src);
    expect(out).not.toContain('insert(knowledge_edge)');
    expect(out).toContain('const x = 1;');
    expect(out).toContain('const y = 2;');
  });

  it('strips a block comment but preserves its newlines (line numbers stay aligned)', () => {
    const src = '/*\n .insert(knowledge)\n line\n*/\ncode.insert(knowledge)';
    const out = stripComments(src);
    // the write inside the block comment is gone...
    const strippedLines = out.split('\n');
    // ...but the number of lines is preserved so the real write stays on its original line (line 5).
    expect(strippedLines).toHaveLength(5);
    expect(strippedLines[4]).toContain('code.insert(knowledge)');
    // only ONE occurrence survives (the real code one, not the comment one).
    expect(out.match(/\.insert\(knowledge\)/g)).toHaveLength(1);
  });

  it('keeps string/template content (a real raw-SQL write lives inside a string)', () => {
    const src = "const q = `UPDATE knowledge SET x=1`; // note\nconst r = 'DELETE FROM goal';";
    const out = stripComments(src);
    expect(out).toContain('UPDATE knowledge SET x=1');
    expect(out).toContain('DELETE FROM goal');
    expect(out).not.toContain('note');
  });

  it('does not treat // inside a string as a comment', () => {
    const src = "const url = 'http://x'; const a = 1;";
    const out = stripComments(src);
    expect(out).toContain("'http://x'");
    expect(out).toContain('const a = 1;');
  });
});

describe('findWriteSites — Drizzle + raw-SQL detection on comment-stripped source', () => {
  const shim =
    (content: Record<string, string>) =>
    (f: string): string | null =>
      f in content ? content[f] : null;

  it('detects Drizzle .update/.insert/.delete on fold-owned tables', () => {
    const content = {
      'a.ts':
        'await db.update(knowledge).set({}); db.insert(goal).values({}); db.delete(artifact);',
    };
    const sites = findWriteSites(['a.ts'], shim(content));
    expect(sites.map((s) => `${s.op}:${s.table}`).sort()).toEqual([
      'delete:artifact',
      'insert:goal',
      'update:knowledge',
    ]);
    expect(sites.every((s) => s.form === 'drizzle')).toBe(true);
  });

  it('disambiguates knowledge from knowledge_edge via the closing paren', () => {
    const content = {
      'a.ts': 'db.insert(knowledge_edge).values({}); db.update(knowledge).set({});',
    };
    const sites = findWriteSites(['a.ts'], shim(content));
    const pairs = sites.map((s) => `${s.op}:${s.table}`).sort();
    expect(pairs).toEqual(['insert:knowledge_edge', 'update:knowledge']);
  });

  it('detects raw-SQL writes inside a string/template', () => {
    const content = {
      'a.ts': 'const q = `UPDATE question_block SET s=1`; const d = "DELETE FROM learning_item";',
    };
    const sites = findWriteSites(['a.ts'], shim(content));
    expect(sites.map((s) => `${s.op}:${s.table}:${s.form}`).sort()).toEqual([
      'delete:learning_item:raw-sql',
      'update:question_block:raw-sql',
    ]);
  });

  it('does NOT count a write that lives only in a comment', () => {
    const content = {
      'a.ts': '// db.insert(knowledge_edge) outside this module is forbidden\nconst x = 1;',
    };
    const sites = findWriteSites(['a.ts'], shim(content));
    expect(sites).toHaveLength(0);
  });

  it('reports line numbers aligned with the original source (block comment preserved)', () => {
    const content = { 'a.ts': '/* block\n comment\n spanning */\ndb.update(goal).set({});' };
    const sites = findWriteSites(['a.ts'], shim(content));
    expect(sites).toHaveLength(1);
    expect(sites[0].line).toBe(4);
  });

  it('skips files that cannot be read', () => {
    const sites = findWriteSites(['gone.ts'], () => null);
    expect(sites).toHaveLength(0);
  });
});

describe('reverseCheckWriters — registry ↔ code drift', () => {
  it('flags a writer whose file is missing', () => {
    const reg = [writer({ file: 'src/gone.ts', marker: 'x' })];
    const stale = reverseCheckWriters(reg, () => null);
    expect(stale).toHaveLength(1);
    expect(stale[0].problem).toBe('file-missing');
  });

  it('flags a writer whose marker no longer appears', () => {
    const reg = [writer({ file: 'src/present.ts', marker: 'OLD_MARKER' })];
    const stale = reverseCheckWriters(reg, () => 'different content');
    expect(stale).toHaveLength(1);
    expect(stale[0].problem).toBe('marker-missing');
  });

  it('passes a writer whose marker still appears (marker check runs on RAW source incl. comments)', () => {
    const reg = [writer({ file: 'src/present.ts', marker: 'createKnowledgeEdge' })];
    const stale = reverseCheckWriters(reg, () => '// uses createKnowledgeEdge helper');
    expect(stale).toHaveLength(0);
  });

  it('caches file reads (reads each file once)', () => {
    const reg = [
      writer({ table: 'knowledge', file: 'src/shared.ts', marker: 'A' }),
      writer({ table: 'goal', file: 'src/shared.ts', marker: 'B' }),
    ];
    let reads = 0;
    reverseCheckWriters(reg, () => {
      reads += 1;
      return 'A and B';
    });
    expect(reads).toBe(1);
  });
});

describe('computeFoldWriteAudit — sanction / violation / allowlist / stale', () => {
  const today = '2026-07-07';
  const goodAllowlistEntry = {
    reason: 'legit exception',
    resolves_when: { kind: 'manual' as const, ref: 'owner review', expected_by: '2027-06-30' },
  };

  it('a write site in a declared sanctioned writer file is sanctioned (not a violation)', () => {
    const sites: WriteSite[] = [
      {
        file: 'src/server/projections/knowledge.ts',
        table: 'knowledge',
        op: 'insert',
        form: 'drizzle',
        line: 1,
      },
    ];
    const reg = [writer({ table: 'knowledge', file: 'src/server/projections/knowledge.ts' })];
    const result = computeFoldWriteAudit(sites, reg, [], {}, today);
    expect(result.violations).toHaveLength(0);
    expect(result.verdicts[0].status).toBe('sanctioned');
    expect(result.verdicts[0].role).toBe('throat');
    expect(result.ok).toBe(true);
  });

  it('a write site in an UNDECLARED file is a VIOLATION', () => {
    const sites: WriteSite[] = [
      {
        file: 'src/capabilities/rogue/endpoint.ts',
        table: 'knowledge_edge',
        op: 'update',
        form: 'drizzle',
        line: 42,
      },
    ];
    const result = computeFoldWriteAudit(sites, [], [], {}, today);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].file).toBe('src/capabilities/rogue/endpoint.ts');
    expect(result.ok).toBe(false);
  });

  it('a STALE sanctioned writer does NOT sanction its site → that site becomes a VIOLATION', () => {
    const w = writer({ table: 'goal', file: 'src/w.ts', marker: 'GONE' });
    const sites: WriteSite[] = [
      { file: 'src/w.ts', table: 'goal', op: 'update', form: 'drizzle', line: 3 },
    ];
    const stale: StaleWriter[] = [{ ...w, problem: 'marker-missing' }];
    const result = computeFoldWriteAudit(sites, [w], stale, {}, today);
    // the writer is stale ⇒ its (table,file) is no longer live-sanctioned ⇒ the site is a violation.
    expect(result.violations).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  it('an allowlisted (table,file) site is ALLOWLISTED not a violation', () => {
    const sites: WriteSite[] = [
      { file: 'src/legacy/writer.ts', table: 'artifact', op: 'update', form: 'drizzle', line: 9 },
    ];
    const allowlist: Allowlist = { 'artifact::src/legacy/writer.ts': goodAllowlistEntry };
    const result = computeFoldWriteAudit(sites, [], [], allowlist, today);
    expect(result.violations).toHaveLength(0);
    expect(result.verdicts[0].status).toBe('allowlisted');
    expect(result.allowlistProblems).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('an allowlist entry matching no live write site is redundant (drift)', () => {
    const allowlist: Allowlist = { 'artifact::src/dead.ts': goodAllowlistEntry };
    const result = computeFoldWriteAudit([], [], [], allowlist, today);
    expect(result.redundantAllowlist).toEqual(['artifact::src/dead.ts']);
    expect(result.ok).toBe(false);
  });

  it('an expired allowlist expected_by is an allowlist problem', () => {
    const sites: WriteSite[] = [
      { file: 'src/legacy/writer.ts', table: 'artifact', op: 'update', form: 'drizzle', line: 9 },
    ];
    const allowlist: Allowlist = {
      'artifact::src/legacy/writer.ts': {
        reason: 'x',
        resolves_when: { kind: 'manual', ref: 'r', expected_by: '2020-01-01' },
      },
    };
    const result = computeFoldWriteAudit(sites, [], [], allowlist, today);
    expect(result.allowlistProblems.length).toBeGreaterThan(0);
    expect(result.ok).toBe(false);
  });
});

describe('validateAllowlistEntry — resolves_when contract', () => {
  const today = '2026-07-07';
  it('accepts a well-formed entry', () => {
    const problems = validateAllowlistEntry(
      'k',
      { reason: 'r', resolves_when: { kind: 'pr', ref: '#42', expected_by: '2027-01-01' } },
      today,
    );
    expect(problems).toHaveLength(0);
  });
  it('rejects a missing reason', () => {
    const problems = validateAllowlistEntry(
      'k',
      { reason: '', resolves_when: { kind: 'pr', ref: '#42', expected_by: '2027-01-01' } },
      today,
    );
    expect(problems.some((p) => p.detail.includes('reason'))).toBe(true);
  });
  it('rejects a bad kind', () => {
    const problems = validateAllowlistEntry(
      'k',
      // intentionally malformed (kind not in the union) for the test.
      {
        reason: 'r',
        resolves_when: { kind: 'nope', ref: '#42', expected_by: '2027-01-01' },
      } as unknown as Parameters<typeof validateAllowlistEntry>[1],
      today,
    );
    expect(problems.some((p) => p.detail.includes('kind'))).toBe(true);
  });
  it('rejects a malformed expected_by', () => {
    const problems = validateAllowlistEntry(
      'k',
      { reason: 'r', resolves_when: { kind: 'pr', ref: '#42', expected_by: 'soon' } },
      today,
    );
    expect(problems.some((p) => p.detail.includes('expected_by'))).toBe(true);
  });
});
