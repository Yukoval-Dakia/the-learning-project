// YUK-1548 (D2/§4.2) — the typed issue contract every block validator returns.
// One stable snake_case vocabulary shared by compose_block, the Zod shape gate
// in the DomainTool bridge, and the later publish-side leak check.

import { z } from 'zod';

export const BLOCK_ISSUE_CODES = [
  // Shape
  'shape_invalid',
  'kind_not_allowed_on_surface',
  'too_large',
  'block_limit_exceeded',
  // Diagram
  'diagram_parse_error',
  'diagram_type_unsupported',
  'diagram_directive_forbidden',
  // Figure
  'svg_parse_error',
  'svg_element_forbidden',
  'svg_attribute_forbidden',
  'svg_external_reference',
  'svg_missing_viewbox',
  'svg_too_complex',
  // Chart
  'chart_series_invalid',
  'chart_tool_result_unresolved',
  // Math
  'math_parse_error',
  // Interactive
  'interactive_forbidden_sequence',
  'interactive_action_invalid',
  'sandbox_preview_failed',
  'sandbox_preview_unavailable',
  // Question ref
  'question_ref_not_servable',
  // Question surface
  'block_text_reveals_key',
] as const;

export const BlockIssueCode = z.enum(BLOCK_ISSUE_CODES);
export type BlockIssueCodeT = z.infer<typeof BlockIssueCode>;

export const BlockIssue = z
  .object({
    code: BlockIssueCode,
    /** JSON pointer into the submitted block; '' = whole block. */
    path: z.string(),
    /** One sentence: what is wrong and what is allowed. */
    detail: z.string(),
    line: z.number().int().min(1).optional(),
    column: z.number().int().min(1).optional(),
    /** ≤12 items: mermaid expected tokens, allowed elements, enum values. */
    expected: z.array(z.string()).max(12).optional(),
  })
  .strict();
export type BlockIssueT = z.infer<typeof BlockIssue>;
