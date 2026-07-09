import curriculum from './curriculum.json';

export interface KnowledgeSeed {
  slug: string; // stable id 用，idempotent seed 靠它
  name: string;
  parent_slug?: string; // 顶级留空，后续多层用
}

export interface Curriculum {
  version: number;
  domain: string;
  knowledge_seeds: KnowledgeSeed[];
}

export function getCurriculum(): Curriculum {
  return curriculum as Curriculum;
}
