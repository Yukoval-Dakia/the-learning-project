// YUK-1059 — assessment release manifest 纯函数单测（lane 分类 / migration
// 归属 / assertions 定义表；零 IO → unit 分区）。
// DB 采集面（collectAssertionContext）由 cutover runbook + scratch run
//（pnpm release:manifest --target=…）实证，不在此 mock。

import { describe, expect, it } from 'vitest';

import {
  type AssertionContext,
  bucketFor,
  buildAssertions,
  buildAssessmentManifest,
  inSeriesBand,
  isSeriesMigration,
  migrationFileTicket,
  parseLaneCommit,
  parseLaneLog,
} from './assessment-manifest';

const CTX_BASE: AssertionContext = {
  outstanding: [],
  epoch: { epoch: 'assessment-contract-v1', state: 'active', seq: 2 },
  migrationsApplied: 111,
  migrationFilesTotal: 111,
  seriesMigrationFiles: ['0104_x.sql'],
  staleSubscriptionDeliveries: 0,
  pendingEvaluations: 0,
  expectedEpoch: 'assessment-contract-v1',
};

const byId = (ctx: AssertionContext) =>
  Object.fromEntries(buildAssertions(ctx).map((a) => [a.id, a]));

describe('bucketFor', () => {
  it('bands: contract / corrective / meta / context', () => {
    expect(bucketFor(1044)).toBe('contract');
    expect(bucketFor(1057)).toBe('contract');
    expect(bucketFor(1091)).toBe('corrective');
    expect(bucketFor(1100)).toBe('corrective');
    expect(bucketFor(1058)).toBe('meta');
    expect(bucketFor(1059)).toBe('meta');
    expect(bucketFor(1040)).toBe('context');
    expect(bucketFor(1043)).toBe('context');
    // 带外票一律 context（parseLaneCommit 会先按 inSeriesBand 过滤）。
    expect(bucketFor(999)).toBe('context');
  });
});

describe('inSeriesBand', () => {
  it('covers 1040-1059 and 1091-1100 only', () => {
    expect(inSeriesBand(1039)).toBe(false);
    expect(inSeriesBand(1040)).toBe(true);
    expect(inSeriesBand(1059)).toBe(true);
    expect(inSeriesBand(1060)).toBe(false);
    expect(inSeriesBand(1090)).toBe(false);
    expect(inSeriesBand(1091)).toBe(true);
    expect(inSeriesBand(1100)).toBe(true);
    expect(inSeriesBand(1101)).toBe(false);
  });
});

describe('parseLaneCommit', () => {
  it('parses squash-merge subjects with PR suffix', () => {
    const row = parseLaneCommit('abc123', 'feat(YUK-1047): something important (#1471)');
    expect(row).toEqual({
      ticket: 'YUK-1047',
      bucket: 'contract',
      sha: 'abc123',
      subject: 'feat(YUK-1047): something important (#1471)',
      pr: 1471,
    });
  });

  it('rejects out-of-band tickets and ticketless subjects', () => {
    expect(parseLaneCommit('a', 'feat(YUK-1060): follow-up')).toBeNull();
    expect(parseLaneCommit('b', 'feat(YUK-1090): nearby')).toBeNull();
    expect(parseLaneCommit('c', 'chore: bump deps')).toBeNull();
    expect(parseLaneCommit('d', 'docs(YUK-1101): too late')).toBeNull();
  });

  it('pr is null when no merge suffix', () => {
    expect(parseLaneCommit('x', 'fix(YUK-1095): direct commit')?.pr).toBeNull();
  });
});

describe('parseLaneLog', () => {
  it('keeps order, drops non-series lines, splits on first tab', () => {
    const log = [
      'h1\tfeat(YUK-1058): gates matrix (#1493)',
      'h2\tchore: unrelated',
      'h3\tfix(YUK-1097): P1 backfill extra\ttabs (#1492)',
      'h4\tfeat(YUK-1044): contract truth (#1468)',
    ].join('\n');
    const rows = parseLaneLog(log);
    expect(rows.map((r) => r.ticket)).toEqual(['YUK-1058', 'YUK-1097', 'YUK-1044']);
    expect(rows[1].pr).toBe(1492);
    expect(rows[1].subject).toBe('fix(YUK-1097): P1 backfill extra\ttabs (#1492)');
  });

  it('empty/malformed input → empty list', () => {
    expect(parseLaneLog('')).toEqual([]);
    expect(parseLaneLog('no-tab-line\n\tlead')).toEqual([]);
  });
});

describe('isSeriesMigration / migrationFileTicket', () => {
  it('filename tag wins for tagged files', () => {
    expect(migrationFileTicket('0104_yuk1044_assessment_contract_truth.sql')).toBe(1044);
    expect(migrationFileTicket('0111_yuk1097_assessment_truth_guards.sql')).toBe(1097);
    expect(migrationFileTicket('0103_lush_marvel_zombies.sql')).toBeNull();
  });

  it('classifies by tag or by introducing-commit subject', () => {
    expect(isSeriesMigration('0109_yuk1055_contract_epoch.sql', 'feat(YUK-1055): x').series).toBe(
      true,
    );
    // untagged file introduced by a series commit counts
    expect(
      isSeriesMigration('0103_lush_marvel_zombies.sql', 'feat(YUK-1048): capture (#1)'),
    ).toEqual({ series: true, ticket: 'YUK-1048' });
    // untagged file introduced by an unrelated commit does not
    expect(isSeriesMigration('0103_lush_marvel_zombies.sql', 'feat(YUK-900): other')).toEqual({
      series: false,
      ticket: null,
    });
    // tagged but out-of-band tag → not series even if commit is in-band
    expect(isSeriesMigration('0098_yuk932_subagent_mailbox.sql', 'feat(YUK-1050): x')).toEqual({
      series: true,
      ticket: 'YUK-1050',
    });
  });
});

describe('buildAssertions', () => {
  it('healthy database context cannot prove runtime migration', () => {
    const m = byId(CTX_BASE);
    expect(m['epoch-active'].status).toBe('ok');
    expect(m['epoch-history'].status).toBe('ok');
    expect(m['no-runtime-fallback'].status).toBe('info');
    expect(m['subscription-translations-zero'].status).toBe('ok');
    expect(m['pending-evaluations-zero'].status).toBe('ok');
    expect(m['migrations-applied'].status).toBe('ok');
    expect(m['translate-outstanding-disposed'].status).toBe('info');
  });

  it('absent epoch marker (pre-cutover) → info/skip, never silent-ok', () => {
    const m = byId({ ...CTX_BASE, epoch: null });
    expect(m['epoch-active'].status).toBe('info');
    expect(m['epoch-history'].status).toBe('skip');
    expect(m['no-runtime-fallback'].status).toBe('info');
  });

  it('wrong/inactive epoch → fail', () => {
    const m = byId({
      ...CTX_BASE,
      epoch: { epoch: 'legacy', state: 'active', seq: 5 },
    });
    expect(m['epoch-active'].status).toBe('fail');
    expect(m['epoch-history'].status).toBe('ok'); // state=active but wrong name
    const m2 = byId({
      ...CTX_BASE,
      epoch: { epoch: 'assessment-contract-v1', state: 'ready', seq: 1 },
    });
    expect(m2['epoch-active'].status).toBe('fail');
    expect(m2['epoch-history'].status).toBe('fail');
  });

  it('translate/fenced outstanding counted separately', () => {
    const m = byId({
      ...CTX_BASE,
      outstanding: [
        { queue: 'judge_run', state: 'created', count: 3, disposition: 'translate' },
        { queue: 'quiz_gen', state: 'retry', count: 2, disposition: 'translate' },
        { queue: 'mystery_dlq', state: 'failed', count: 7, disposition: 'fenced' },
        { queue: 'note_refine', state: 'created', count: 1, disposition: 'drain' },
      ],
    });
    expect(m['translate-outstanding-disposed'].detail).toContain('translate=5');
    expect(m['translate-outstanding-disposed'].detail).toContain('fenced=7');
  });

  it('stale deliveries / pending evaluations / drift → fail; absent tables → info', () => {
    const m = byId({
      ...CTX_BASE,
      staleSubscriptionDeliveries: 4,
      pendingEvaluations: 2,
      migrationsApplied: 100,
    });
    expect(m['subscription-translations-zero'].status).toBe('fail');
    expect(m['pending-evaluations-zero'].status).toBe('fail');
    expect(m['migrations-applied'].status).toBe('fail');
    const absent = byId({
      ...CTX_BASE,
      staleSubscriptionDeliveries: null,
      pendingEvaluations: null,
      migrationsApplied: null,
    });
    expect(absent['subscription-translations-zero'].status).toBe('info');
    expect(absent['pending-evaluations-zero'].status).toBe('info');
    expect(absent['migrations-applied'].status).toBe('info');
  });

  it('every assertion has statement + verify text (runbook cross-ref intact)', () => {
    for (const a of buildAssertions(CTX_BASE)) {
      expect(a.statement.length).toBeGreaterThan(10);
      expect(a.verify.length).toBeGreaterThan(5);
      expect(['unified-write', 'no-fallback', 'translations', 'integrity']).toContain(a.group);
    }
  });
});

describe('buildAssessmentManifest', () => {
  it('seals kind/epochs/rollback boundaries without mutating inputs', () => {
    const row = parseLaneCommit('s1', 'feat(YUK-1044): x (#1)');
    if (row === null) throw new Error('fixture lane parse failed');
    const m = buildAssessmentManifest({
      lanes: [row],
      migrations: [{ file: '0104_yuk1044_x.sql', addedBy: 's1', ticket: 'YUK-1044' }],
      seriesBase: 'base9',
      assertions: buildAssertions(CTX_BASE),
    });
    expect(m.kind).toBe('assessment-release-manifest');
    expect(m.contract_epoch).toBe('assessment-contract-v1');
    // post-flip：发布代码自身的 epoch 即 assessment-contract-v1（code_epoch_before
    // 记录的是【生成本 manifest 的代码】的 epoch，翻转后等于目标 epoch）。
    expect(m.code_epoch_before).toBe('assessment-contract-v1');
    expect(m.series_base).toBe('base9');
    expect(m.rollback.boundary_a).toContain('restore');
    expect(m.rollback.boundary_b).toContain('roll-forward');
    expect(m.notes.join(' ')).toContain('部署');
  });
});
