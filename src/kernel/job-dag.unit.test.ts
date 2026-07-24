import { describe, expect, it } from 'vitest';
import {
  type JobDagMemberInput,
  buildJobDag,
  findCycle,
  normalizeJobDependency,
  validateJobDag,
} from './job-dag';

const member = (
  name: string,
  dependsOn: JobDagMemberInput['dependsOn'] = [],
  owner = 'cap',
): JobDagMemberInput => ({ name, owner, dependsOn });

describe('normalizeJobDependency', () => {
  it('treats a bare string as a hard edge', () => {
    expect(normalizeJobDependency('up')).toEqual({ job: 'up', soft: false });
  });
  it('preserves an explicit soft flag', () => {
    expect(normalizeJobDependency({ job: 'up', soft: true })).toEqual({ job: 'up', soft: true });
  });
  it('defaults an object without soft to hard', () => {
    expect(normalizeJobDependency({ job: 'up' })).toEqual({ job: 'up', soft: false });
  });
});

describe('validateJobDag', () => {
  const names = (...ns: string[]) => new Set(ns);

  it('accepts a valid acyclic graph with roots, hard and soft edges', () => {
    const members = [member('a'), member('b', ['a']), member('c', [{ job: 'a', soft: true }, 'b'])];
    expect(() => validateJobDag(members, names('a', 'b', 'c'))).not.toThrow();
  });

  it('accepts an empty member set', () => {
    expect(() => validateJobDag([], names('bare_cron'))).not.toThrow();
  });

  it('rejects a self-dependency', () => {
    expect(() => validateJobDag([member('a', ['a'])], names('a'))).toThrow(/self-dependency/);
  });

  it('rejects a duplicate edge on one node', () => {
    expect(() => validateJobDag([member('a'), member('b', ['a', 'a'])], names('a', 'b'))).toThrow(
      /duplicate dependency on 'a'/,
    );
  });

  it('rejects a dependency on a job that does not exist at all', () => {
    expect(() => validateJobDag([member('b', ['ghost'])], names('b'))).toThrow(
      /depends on unknown job 'ghost'/,
    );
  });

  it('rejects a dependency on a real job that is not a DAG member (bare cron)', () => {
    // `bare` exists as a job (in allJobNames) but is not among the members → not orchestrated.
    expect(() => validateJobDag([member('b', ['bare'])], names('b', 'bare'))).toThrow(
      /not an orchestrated DAG member/,
    );
  });

  it('rejects a direct 2-cycle', () => {
    const members = [member('a', ['b']), member('b', ['a'])];
    expect(() => validateJobDag(members, names('a', 'b'))).toThrow(/cycle detected/);
  });

  it('rejects a longer cycle a -> b -> c -> a', () => {
    const members = [member('a', ['c']), member('b', ['a']), member('c', ['b'])];
    expect(() => validateJobDag(members, names('a', 'b', 'c'))).toThrow(/cycle detected/);
  });

  it('does not flag a diamond (shared upstream, shared downstream) as a cycle', () => {
    const members = [
      member('top'),
      member('left', ['top']),
      member('right', ['top']),
      member('bottom', ['left', 'right']),
    ];
    expect(() => validateJobDag(members, names('top', 'left', 'right', 'bottom'))).not.toThrow();
  });
});

describe('findCycle', () => {
  it('returns null for an acyclic graph', () => {
    expect(findCycle([member('a'), member('b', ['a'])])).toBeNull();
  });

  it('returns the cycle path for a cyclic graph', () => {
    const cycle = findCycle([member('a', ['c']), member('b', ['a']), member('c', ['b'])]);
    expect(cycle).not.toBeNull();
    // The returned path starts and ends on the same node.
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('buildJobDag', () => {
  it('derives roots, nodes and reverse-adjacency dependents', () => {
    const dag = buildJobDag([
      member('a'),
      member('b', ['a']),
      member('c', [{ job: 'a', soft: true }, 'b']),
    ]);
    expect(dag.roots).toEqual(['a']);
    expect([...dag.nodes.keys()].sort()).toEqual(['a', 'b', 'c']);
    // `a` feeds b (hard) and c (soft).
    expect(dag.dependents.get('a')).toEqual([
      { job: 'b', soft: false },
      { job: 'c', soft: true },
    ]);
    // `b` feeds c (hard).
    expect(dag.dependents.get('b')).toEqual([{ job: 'c', soft: false }]);
    // `c` is a leaf → empty bucket.
    expect(dag.dependents.get('c')).toEqual([]);
    expect(dag.nodes.get('c')?.deps).toEqual([
      { job: 'a', soft: true },
      { job: 'b', soft: false },
    ]);
  });
});
