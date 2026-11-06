// YUK-1548 (D1/§3) — the one generative-UI block family, shared by chat
// replies, note bodies and question materials. The canonical stored form is a
// `tlp-block` fenced code block carrying one JSON member of this union.
//
// Two schema layers on purpose:
//   - BlockInputV1: what compose_block accepts (figure `svg`, interactive
//     `html` payloads that the server sanitises and replaces with assets).
//     The svg/asset and html/code "exactly one of" invariants are enforced by
//     the tool validator so they surface as typed issues, not shape errors.
//   - BlockV1: what can be stored/shown (asset refs only, never raw payloads).

import { z } from 'zod';

const Common = {
  v: z.literal(1),
  alt: z.string().min(1).max(300).meta({
    description: 'One-sentence description read by screen readers; never the answer.',
  }),
  caption: z.string().max(200).optional(),
};

export const FigureAssetRef = z
  .object({
    asset_id: z.string().regex(/^svf_[0-9a-f]{32}$/),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export const SandboxCodeRef = z
  .object({
    asset_id: z.string().regex(/^sbh_[0-9a-f]{32}$/),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

const DIAGRAM_DESCRIPTION =
  'Flowchart / sequence / state / mindmap / timeline / ER / class diagram rendered deterministically from Mermaid 12 source. No click/href/callback statements, no %%{} directives, no raw HTML labels, no url() in style/classDef.';

export const DiagramBlock = z
  .object({
    ...Common,
    kind: z.literal('diagram'),
    engine: z.literal('mermaid'),
    source: z.string().min(1).max(8_000).meta({
      description: 'Mermaid 12 source; one of the allowlisted diagram types.',
    }),
  })
  .strict()
  .meta({ description: DIAGRAM_DESCRIPTION });

const FIGURE_DESCRIPTION =
  'A drawing the model authors as inline SVG (apparatus, force diagram, geometry, circuit). The server re-serialises it from an element/attribute allowlist, stores it as a write-once content-addressed asset, and returns a raster for self-check.';

export const FigureBlockInput = z
  .object({
    ...Common,
    kind: z.literal('figure'),
    svg: z
      .string()
      .min(1)
      .max(200_000)
      .optional()
      .meta({ description: 'Inline SVG source; replaced server-side by `asset`.' }),
    asset: FigureAssetRef.optional(),
    long_desc: z.string().max(2_000).optional().meta({
      description: 'Full text description of every labelled part; required on questions.',
    }),
  })
  .strict()
  .meta({ description: FIGURE_DESCRIPTION });

export const FigureBlock = FigureBlockInput.omit({ svg: true })
  .extend({ asset: FigureAssetRef })
  .strict();
export type FigureBlockT = z.infer<typeof FigureBlock>;

export const ChartBlock = z
  .object({
    ...Common,
    kind: z.literal('chart'),
    chart: z.enum(['bar', 'line', 'scatter', 'pie']),
    stacked: z.boolean().optional(),
    x: z
      .object({
        label: z.string().max(40),
        unit: z.string().max(12).optional(),
        scale: z.enum(['category', 'linear', 'time']),
      })
      .strict(),
    y: z
      .object({
        label: z.string().max(40),
        unit: z.string().max(12).optional(),
        min: z.number().optional(),
        max: z.number().optional(),
      })
      .strict(),
    series: z
      .array(
        z
          .object({
            name: z.string().max(40),
            points: z.array(z.tuple([z.union([z.string(), z.number()]), z.number()])).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    data_source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('model') }).strict(),
      z
        .object({
          kind: z.literal('tool_result'),
          tool_use_id: z.string(),
          path: z.string().max(200),
        })
        .strict(),
    ]),
  })
  .strict()
  .meta({ description: 'A bar/line/scatter/pie chart from declared data.' });

const InteractiveField = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    type: z.enum(['string', 'number', 'boolean', 'enum']),
    max_len: z.number().int().max(500).optional(),
    options: z.array(z.string().max(60)).max(20).optional(),
  })
  .strict();

const InteractiveActions = z
  .array(
    z
      .object({
        action_id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
        kind: z.literal('send_to_companion'),
        label: z.string().min(1).max(30),
        message_template: z.string().min(1).max(300),
        fields: z.array(InteractiveField).max(8),
      })
      .strict(),
  )
  .max(4)
  .default([]);

export const InteractiveBlockInput = z
  .object({
    ...Common,
    kind: z.literal('interactive'),
    title: z.string().min(1).max(60),
    html: z
      .string()
      .min(1)
      .max(256 * 1024)
      .optional()
      .meta({ description: 'Sandboxed HTML source; replaced server-side by `code`.' }),
    code: SandboxCodeRef.optional(),
    height_px: z.number().int().min(120).max(720).optional(),
    actions: InteractiveActions,
  })
  .strict()
  .meta({ description: 'A sandboxed interactive card with host-confirmed return actions.' });

export const InteractiveBlock = InteractiveBlockInput.omit({ html: true })
  .extend({ code: SandboxCodeRef })
  .strict();

export const QuestionRefBlock = z
  .object({
    ...Common,
    kind: z.literal('question_ref'),
    question_ids: z.array(z.string().min(1).max(256)).min(1).max(5),
    display: z.enum(['link', 'inline']).default('link'),
    label: z.string().max(30),
  })
  .strict()
  .meta({
    description:
      'Question card by bank id only. display=link opens the question; inline is one question with in-place practice, disabled until admitted. alt must be 题目, label must be 打开题目; omit caption.',
  });

/** Model-facing input union (payload fields allowed). */
export const BlockInputV1 = z.discriminatedUnion('kind', [
  DiagramBlock,
  FigureBlockInput,
  ChartBlock,
  InteractiveBlockInput,
  QuestionRefBlock,
]);
export type BlockInputV1T = z.infer<typeof BlockInputV1>;

/** Stored/wire union: every payload field has been resolved to an asset ref. */
export const BlockV1 = z.discriminatedUnion('kind', [
  DiagramBlock,
  FigureBlock,
  ChartBlock,
  InteractiveBlock,
  QuestionRefBlock,
]);
export type BlockV1T = z.infer<typeof BlockV1>;
export type BlockKind = BlockV1T['kind'];
