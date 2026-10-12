// Copilot Drawer tool-use display modes (Wave 5 / T-D3/A, YUK-122):
//   • chainRowCost   — how much cost detail to surface on tool-use chain rows
//   • toolUseDetail  — folded vs expanded tool-use card body default
//
// Only the mode types remain: ToolUseCard takes them as props. The stored
// tweak hooks and their localStorage accessors had no consumer and were
// removed (YUK-1483).

export const CHAIN_ROW_COST_OPTIONS = ['summary-only', 'hover-on-row', 'always-show'] as const;
export type ChainRowCostMode = (typeof CHAIN_ROW_COST_OPTIONS)[number];

export const TOOL_USE_DETAIL_OPTIONS = ['folded', 'expanded', 'off'] as const;
export type ToolUseDetailMode = (typeof TOOL_USE_DETAIL_OPTIONS)[number];
