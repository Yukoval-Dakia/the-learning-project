// YUK-307 (presentation layer §2.3/§2.5) — unit tests for the pure hero-routing
// resolver. Node vitest env (no jsdom); resolveArtifactHero is React-free so the
// routing contract is testable without rendering CopilotHeroCard.

import { describe, expect, it } from 'vitest';
import { isInteractiveArtifactRef, resolveArtifactHero } from './hero';

describe('resolveArtifactHero', () => {
  it('routes note → /notes/{id} with the 笔记 reference card', () => {
    expect(resolveArtifactHero({ kind: 'note', id: 'note_abc' })).toEqual({
      label: '笔记',
      icon: 'doc',
      href: '/notes/note_abc',
    });
  });

  it('routes interactive → /notes/{id} (generic artifact viewer, sparkle icon)', () => {
    expect(resolveArtifactHero({ kind: 'interactive', id: 'art_xyz' })).toEqual({
      label: '互动内容',
      icon: 'sparkle',
      href: '/notes/art_xyz',
    });
  });

  it('routes question → /questions/{id} (read-only question detail)', () => {
    expect(resolveArtifactHero({ kind: 'question', id: 'q_001' })).toEqual({
      label: '题目',
      icon: 'quiz',
      href: '/questions/q_001',
    });
  });

  it('routes quiz / paper → /practice/{id} (paper artifact)', () => {
    expect(resolveArtifactHero({ kind: 'quiz', id: 'art_paper' })).toEqual({
      label: '练习',
      icon: 'layers',
      href: '/practice/art_paper',
    });
    expect(resolveArtifactHero({ kind: 'paper', id: 'art_paper' })?.href).toBe(
      '/practice/art_paper',
    );
  });

  it('routes Chinese kind synonyms (题 / 卷 / 笔记 / 互动)', () => {
    expect(resolveArtifactHero({ kind: '题', id: 'q_1' })?.href).toBe('/questions/q_1');
    expect(resolveArtifactHero({ kind: '题目', id: 'q_1' })?.href).toBe('/questions/q_1');
    expect(resolveArtifactHero({ kind: '卷', id: 'art_1' })?.href).toBe('/practice/art_1');
    expect(resolveArtifactHero({ kind: '试卷', id: 'art_1' })?.href).toBe('/practice/art_1');
    expect(resolveArtifactHero({ kind: '笔记', id: 'n_1' })?.href).toBe('/notes/n_1');
    expect(resolveArtifactHero({ kind: '互动', id: 'n_1' })?.label).toBe('互动内容');
  });

  it('is case-insensitive and trims surrounding whitespace on kind', () => {
    expect(resolveArtifactHero({ kind: 'NOTE', id: 'n' })?.href).toBe('/notes/n');
    expect(resolveArtifactHero({ kind: '  Quiz  ', id: 'a' })?.href).toBe('/practice/a');
  });

  it('returns null for an unrecognised kind (card renders link-less)', () => {
    expect(resolveArtifactHero({ kind: 'mystery', id: 'x' })).toBeNull();
    expect(resolveArtifactHero({ kind: '', id: 'x' })).toBeNull();
  });

  it('encodeURIComponent-escapes a malformed id (defense-in-depth, same-origin)', () => {
    // Normal ids round-trip unchanged; a malformed id is escaped, not broken out.
    expect(resolveArtifactHero({ kind: 'note', id: 'note_abc' })?.href).toBe('/notes/note_abc');
    expect(resolveArtifactHero({ kind: 'note', id: '../evil' })?.href).toBe('/notes/..%2Fevil');
    expect(resolveArtifactHero({ kind: 'note', id: 'a b?x=1' })?.href).toBe('/notes/a%20b%3Fx%3D1');
  });
});

// ADR-0033 D5 (YUK-203) — predicate that decides whether a {source:'artifact'}
// hero inline-renders the sandboxed interactive (after fetching its html) vs.
// shows the plain reference card. Pure (kind-only); the html fetch + render live
// in CopilotHeroCard (not unit-tested on the node-only stack).
describe('isInteractiveArtifactRef', () => {
  it('true for the interactive kind labels (en + zh)', () => {
    expect(isInteractiveArtifactRef('interactive')).toBe(true);
    expect(isInteractiveArtifactRef('互动')).toBe(true);
  });

  it('is case-insensitive and trims whitespace (matches resolveArtifactHero)', () => {
    expect(isInteractiveArtifactRef('  INTERACTIVE  ')).toBe(true);
    expect(isInteractiveArtifactRef(' 互动 ')).toBe(true);
  });

  it('false for non-interactive kinds (they keep the reference card)', () => {
    expect(isInteractiveArtifactRef('note')).toBe(false);
    expect(isInteractiveArtifactRef('笔记')).toBe(false);
    expect(isInteractiveArtifactRef('question')).toBe(false);
    expect(isInteractiveArtifactRef('quiz')).toBe(false);
    expect(isInteractiveArtifactRef('')).toBe(false);
    expect(isInteractiveArtifactRef('mystery')).toBe(false);
  });
});
