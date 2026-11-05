// YUK-1548 — the public wire surface of the block family (UI line + tools).
// Named re-exports only: each entry is classified stable_contract in
// scripts/pass-through-classifications.jsonl.

export type { BlockInputV1T, BlockKind, BlockV1T, FigureBlockT } from './block';
export {
  BlockInputV1,
  BlockV1,
  ChartBlock,
  DiagramBlock,
  FigureAssetRef,
  FigureBlock,
  FigureBlockInput,
  InteractiveBlock,
  InteractiveBlockInput,
  QuestionRefBlock,
  SandboxCodeRef,
} from './block';
export { renderBlockCatalogue } from './catalogue';
export {
  BLOCK_PLACE_PATTERN,
  BLOCK_REF_PATTERN,
  BLOCK_REF_SCHEME,
  TLP_BLOCK_FENCE_INFO,
  canonicalBlockJson,
  parseBlockFence,
  serializeBlockFence,
} from './fence';
export type { BlockIssueCodeT, BlockIssueT } from './issues';
export { BLOCK_ISSUE_CODES, BlockIssue, BlockIssueCode } from './issues';
export type { BlockSurface } from './surfaces';
export { BLOCK_IMPLEMENTED_KINDS, BLOCK_SURFACE_KINDS } from './surfaces';
