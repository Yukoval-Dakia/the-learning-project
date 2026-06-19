import { describe, expect, it } from 'vitest';
import {
  CORE_RELATION_TYPES,
  type ConsumerEntry,
  type StaleConsumer,
  computeDeadEdges,
  findExperimentalRelations,
  reverseCheckConsumers,
} from './audit-relations';

// YUK-357 / RT4 — KG 死边反向审计的死边检测逻辑回归。
//
// 「死边」= 某 relation_type 被造出来但没有任何 specialized 下游消费路径（诊断/
// 推荐/复习按 type 驱动行为）。这些测试钉住三件事：
//   (1) computeDeadEdges 只认 specialized 为「活」，generic-read / creation-validation
//       不救活（忠于 GPT §10.1「只保留能影响诊断/推荐/复习的关系」）。
//   (2) reverseCheckConsumers 抓 registry↔代码漂移（声明的消费路径文件/marker 消失）。
//   (3) stale 的消费路径不计入「活」——消费代码删了，边就该被判死。

function entry(over: Partial<ConsumerEntry>): ConsumerEntry {
  return {
    relation: 'prerequisite',
    tier: 'specialized',
    file: 'src/some/file.ts',
    marker: 'MARKER',
    surface: 'diagnosis',
    evidence: 'test',
    ...over,
  };
}

describe('computeDeadEdges — dead = no LIVE specialized consumer', () => {
  it('a relation WITH a specialized consumer is live (not dead)', () => {
    const reg = [entry({ relation: 'prerequisite', tier: 'specialized' })];
    const result = computeDeadEdges(reg, []);
    const v = result.verdicts.find((x) => x.relation === 'prerequisite');
    expect(v?.dead).toBe(false);
    expect(v?.maxTier).toBe('specialized');
    expect(result.dead).not.toContain('prerequisite');
  });

  it('a relation with ONLY generic-read is DEAD (generic dump does not count as learning impact)', () => {
    const reg = [entry({ relation: 'applied_in', tier: 'generic-read' })];
    const result = computeDeadEdges(reg, []);
    const v = result.verdicts.find((x) => x.relation === 'applied_in');
    expect(v?.dead).toBe(true);
    expect(v?.maxTier).toBe('generic-read');
    expect(result.dead).toContain('applied_in');
  });

  it('a relation with ONLY creation-validation is DEAD (validation ≠ downstream learning consumption)', () => {
    const reg = [
      entry({ relation: 'applied_in', tier: 'creation-validation', surface: 'validation' }),
    ];
    const result = computeDeadEdges(reg, []);
    expect(result.dead).toContain('applied_in');
  });

  it('a relation with NO consumer at all is DEAD with maxTier=none', () => {
    // registry references only OTHER relations → applied_in has zero rows.
    const reg = [entry({ relation: 'prerequisite', tier: 'specialized' })];
    const result = computeDeadEdges(reg, []);
    const v = result.verdicts.find((x) => x.relation === 'applied_in');
    expect(v?.dead).toBe(true);
    expect(v?.maxTier).toBe('none');
    expect(v?.consumers).toHaveLength(0);
  });

  it('generic-read + creation-validation together still DEAD without specialized', () => {
    const reg = [
      entry({ relation: 'applied_in', tier: 'generic-read' }),
      entry({ relation: 'applied_in', tier: 'creation-validation', surface: 'validation' }),
    ];
    const result = computeDeadEdges(reg, []);
    expect(result.dead).toContain('applied_in');
    // maxTier picks the highest of the two LIVE tiers.
    expect(result.verdicts.find((x) => x.relation === 'applied_in')?.maxTier).toBe('generic-read');
  });

  it('every core relation_type gets a verdict row', () => {
    const result = computeDeadEdges([], []);
    expect(result.verdicts.map((v) => v.relation).sort()).toEqual([...CORE_RELATION_TYPES].sort());
    // empty registry ⇒ all dead.
    expect(result.dead.sort()).toEqual([...CORE_RELATION_TYPES].sort());
  });
});

describe('computeDeadEdges — STALE consumers do NOT keep an edge alive', () => {
  it('a specialized consumer that is stale is dropped → relation becomes DEAD', () => {
    const e = entry({ relation: 'prerequisite', tier: 'specialized' });
    const stale: StaleConsumer[] = [{ ...e, problem: 'marker-missing' }];
    const result = computeDeadEdges([e], stale);
    const v = result.verdicts.find((x) => x.relation === 'prerequisite');
    expect(v?.dead).toBe(true);
    expect(v?.consumers).toHaveLength(0); // the stale entry was excluded
    expect(result.ok).toBe(false); // stale present ⇒ not ok
  });

  it('ok is false when any stale exists even if no edge is dead', () => {
    const live = entry({ relation: 'prerequisite', tier: 'specialized', marker: 'LIVE' });
    const otherSpecialized = CORE_RELATION_TYPES.filter((r) => r !== 'prerequisite').map((r) =>
      entry({ relation: r, tier: 'specialized', marker: `LIVE_${r}` }),
    );
    const reg = [live, ...otherSpecialized];
    // a redundant stale generic-read on prerequisite (prerequisite still has LIVE specialized)
    const stale: StaleConsumer[] = [
      {
        ...entry({ relation: 'prerequisite', tier: 'generic-read', marker: 'GONE' }),
        problem: 'file-missing',
      },
    ];
    const result = computeDeadEdges(
      [...reg, entry({ relation: 'prerequisite', tier: 'generic-read', marker: 'GONE' })],
      stale,
    );
    expect(result.dead).toHaveLength(0); // every relation still has a live specialized consumer
    expect(result.ok).toBe(false); // but stale drift ⇒ not ok
  });
});

describe('reverseCheckConsumers — registry ↔ code drift detection', () => {
  it('flags an entry whose file is missing', () => {
    const reg = [entry({ file: 'src/gone.ts', marker: 'x' })];
    const stale = reverseCheckConsumers(reg, () => null);
    expect(stale).toHaveLength(1);
    expect(stale[0].problem).toBe('file-missing');
  });

  it('flags an entry whose marker no longer appears in the file', () => {
    const reg = [entry({ file: 'src/present.ts', marker: 'OLD_MARKER' })];
    const stale = reverseCheckConsumers(reg, () => 'this file has different content');
    expect(stale).toHaveLength(1);
    expect(stale[0].problem).toBe('marker-missing');
  });

  it('passes an entry whose marker still appears', () => {
    const reg = [entry({ file: 'src/present.ts', marker: 'STILL_HERE' })];
    const stale = reverseCheckConsumers(reg, () => 'code with STILL_HERE inside');
    expect(stale).toHaveLength(0);
  });

  it('caches file reads (reads each file once even with multiple entries)', () => {
    const reg = [
      entry({ relation: 'prerequisite', file: 'src/shared.ts', marker: 'A' }),
      entry({ relation: 'related_to', file: 'src/shared.ts', marker: 'B' }),
    ];
    let reads = 0;
    reverseCheckConsumers(reg, () => {
      reads += 1;
      return 'A and B';
    });
    expect(reads).toBe(1);
  });
});

describe('findExperimentalRelations — observability for experimental:* edges', () => {
  it('extracts experimental:* literals on a relation_type line', () => {
    const files = ['a.ts', 'b.ts'];
    const src: Record<string, string> = {
      'a.ts': "  relation_type: 'experimental:contrasts_register',",
      'b.ts': 'no experimental literals here',
    };
    const found = findExperimentalRelations(files, (f) => src[f] ?? '');
    expect(found).toEqual(['experimental:contrasts_register']);
  });

  it('IGNORES experimental:* event names not on a relation_type line (the false-positive guard)', () => {
    // experimental:quiz_gen is an event NAME, not a relation_type — must be excluded.
    const src = "writeEvent({ type: 'experimental:quiz_gen' });";
    const found = findExperimentalRelations(['a.ts'], () => src);
    expect(found).toEqual([]);
  });

  it('returns empty when no experimental relations are wired', () => {
    const found = findExperimentalRelations(
      ['a.ts'],
      () => "const x: relation_type = 'prerequisite';",
    );
    expect(found).toEqual([]);
  });

  it('dedupes and sorts (relation_type context required on each line)', () => {
    const src =
      "relation_type: 'experimental:b'\nnew_relation_type: 'experimental:a'\nrelation_type: 'experimental:b'";
    const found = findExperimentalRelations(['a.ts'], () => src);
    expect(found).toEqual(['experimental:a', 'experimental:b']);
  });
});
