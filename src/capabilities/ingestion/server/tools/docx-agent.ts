import {
  DocxDraftInput,
  type DocxDraftInputT,
  DocxReadInput,
  type DocxReadInputT,
  DocxToolOutput,
} from '@/core/schema/docx-agent';
import type { DomainTool } from './types';

export const readDocxSourceTool: DomainTool<DocxReadInputT, Record<string, unknown>> = {
  name: 'read_docx_source',
  effect: 'read',
  costClass: 'local',
  mirrorEvent: 'never',
  description:
    'List all files for this DOCX ingestion, read source text by character offset, or view a page/embedded image with optional normalized crop. Use only asset_id handles from list; no paths, URLs or shell.',
  inputSchema: DocxReadInput,
  outputSchema: DocxToolOutput,
  async execute(ctx, input) {
    if (!ctx.docxWorkspace) throw new Error('DOCX workspace is not bound to this run');
    return ctx.docxWorkspace.read(input);
  },
  summarize(input) {
    return `DOCX source ${input.action}`;
  },
};
export const editDocxDraftsTool: DomainTool<DocxDraftInputT, Record<string, unknown>> = {
  name: 'edit_docx_drafts',
  effect: 'write',
  costClass: 'local',
  mirrorEvent: 'when_causal',
  description:
    'Inspect durable drafts and revision; upsert complete question trees with stable keys and page/figure references; record coverage for each source page/media; check gaps; commit the batch. Upsert/commit require expected_revision. Existing keys revise the same draft. Partial commits retain unresolved questions/material. Never asserts formal answerability.',
  inputSchema: DocxDraftInput,
  outputSchema: DocxToolOutput,
  async execute(ctx, input) {
    if (!ctx.docxWorkspace) throw new Error('DOCX workspace is not bound to this run');
    return ctx.docxWorkspace.drafts(input);
  },
  summarize(input) {
    return `DOCX drafts ${input.action}`;
  },
};
