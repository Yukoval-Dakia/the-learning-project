import { describe, expect, it } from 'vitest';
import { matchesSubjectDomain } from './knowledge-tree';

describe('matchesSubjectDomain', () => {
  it.each([
    ['yuwen', 'yuwen'],
    ['wenyan', 'yuwen'],
    ['  WENYAN  ', 'yuwen'],
    ['math', 'math'],
  ])('matches known subject aliases (%s, %s)', (subject, domain) => {
    expect(matchesSubjectDomain(subject, domain)).toBe(true);
  });

  it('rejects null and unknown domains for a known subject', () => {
    expect(matchesSubjectDomain('yuwen', null)).toBe(false);
    expect(matchesSubjectDomain('yuwen', 'chemistry')).toBe(false);
  });

  it('matches an observed unknown subject only by normalized raw identity', () => {
    expect(matchesSubjectDomain(' yingyu ', 'YINGYU')).toBe(true);
    expect(matchesSubjectDomain('yingyu', 'yingyu-extra')).toBe(false);
    expect(matchesSubjectDomain('unknown', null)).toBe(false);
  });
});
