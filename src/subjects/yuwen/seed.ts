import curriculum from './curriculum.json';

export interface KnowledgeSeed {
  slug: string; // Stable id; idempotent seeds key on it.
  name: string;
  parent_slug?: string; // Omitted at the top level.
}

export interface Curriculum {
  version: number;
  domain: string;
  knowledge_seeds: KnowledgeSeed[];
}

export function getCurriculum(): Curriculum {
  return curriculum as Curriculum;
}
