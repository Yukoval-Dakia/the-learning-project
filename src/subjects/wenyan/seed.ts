import curriculum from './curriculum.json';

export interface KnowledgeSeed {
  name: string;
  parent_name?: string;
}

export interface Curriculum {
  version: number;
  domain: string;
  knowledge_seeds: KnowledgeSeed[];
}

export function getCurriculum(): Curriculum {
  return curriculum as Curriculum;
}
