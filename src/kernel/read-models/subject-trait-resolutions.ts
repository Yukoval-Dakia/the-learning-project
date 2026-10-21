// Trait assembly provenance cache (db-free). The hydrate engine is the sole writer;
// readers only need this in-memory map. Each hydrate replaces the map reference,
// leaving in-flight captured references stable.

import type { TraitVersionComponent } from '@/subjects/trait-compose';
import type { SubjectTraitKind } from '@/subjects/trait-schemas';

export type TraitDegradation = 'journal_fallback' | 'code_seed' | null;

// Per (subject, kind): revision (live), effective, and degraded, shared by
// provenance readers.
export interface TraitResolution {
  kind: SubjectTraitKind;
  traitId: string;
  origin: 'builtin' | 'custom';
  ownerSubjectId: string | null;
  seedVersion: string | null;
  liveRevision: number;
  effective: TraitVersionComponent['effective'];
  degraded: TraitDegradation;
}

let traitResolutions = new Map<string, TraitResolution[]>();

export function getSubjectTraitResolutions(): ReadonlyMap<string, TraitResolution[]> {
  return traitResolutions;
}

// Sole writer: hydrate replaces the whole map.
export function replaceSubjectTraitResolutions(next: Map<string, TraitResolution[]>): void {
  traitResolutions = next;
}

// Derived, not stored: true when all six bound traits are general seed traits by
// identity, so an edited general still counts. general itself returns null; subjects
// with no hydration return false.
export function isGeneralFallbackFor(subjectId: string): boolean | null {
  if (subjectId === 'general') return null;
  const res = traitResolutions.get(subjectId);
  if (!res || res.length === 0) return false;
  return res.every((r) => r.traitId.startsWith('trt_seed_general_'));
}
