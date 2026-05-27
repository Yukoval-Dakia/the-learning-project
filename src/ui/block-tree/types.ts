import type { ArtifactBodyBlocksT } from '@/core/schema/business';

export type BlockTreeDoc = ArtifactBodyBlocksT;

export interface BlockTreeMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface BlockTreeNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: BlockTreeNode[];
  marks?: BlockTreeMark[];
  text?: string;
  [key: string]: unknown;
}

export type SemanticKind = 'definition' | 'mechanism' | 'example' | 'pitfall' | 'check';
export type SourceTier = 'llm_only' | 'search_grounded' | 'textbook' | 'user_verified';

export interface SemanticBlockAttrs {
  id: string;
  semantic_kind: SemanticKind;
  source_tier?: SourceTier;
  user_verified?: boolean;
  embedded_check?: { question_ids: string[] } | null;
  version?: number;
  derived_from_block_id?: string;
}

export const SEMANTIC_BLOCK_NODE = 'semanticBlock';
export const CROSS_LINK_BLOCK_NODE = 'crossLinkBlock';
export const ARTIFACT_REF_BLOCK_NODE = 'artifactRefBlock';
export const CALLOUT_BLOCK_NODE = 'calloutBlock';
export const AUTO_LINKS_CONTAINER_NODE = 'autoLinksContainer';

export const SEMANTIC_KIND_LABEL: Record<SemanticKind, string> = {
  definition: '定义',
  mechanism: '机制 / 规则',
  example: '例',
  pitfall: '易错',
  check: '自检',
};

export const SOURCE_TIER_LABEL: Record<SourceTier, string> = {
  llm_only: 'AI 单 pass',
  search_grounded: 'search-grounded',
  textbook: '教材',
  user_verified: '已核',
};
