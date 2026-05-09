import { z } from 'zod';

const ProposalSchema = z.object({
  name: z.string().min(1).max(80),
  parent_id: z.string().min(1),
  reasoning: z.string().min(1).max(500),
});

const OutputSchema = z.object({
  proposals: z.array(ProposalSchema).max(3),
});

export type ProposeOutput = z.infer<typeof OutputSchema>;

export function parseProposeOutput(text: string): ProposeOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`parseProposeOutput: no JSON object found in text`);
  }
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (e) {
    throw new Error(`parseProposeOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return OutputSchema.parse(json);
}
