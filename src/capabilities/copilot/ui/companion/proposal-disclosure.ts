// A reply whose turn called propose_* tools carries a server-composed disclosure block at its end
// (server/reply-finalization.ts proposalDisclosure). Its wording is a contract record (tool names,
// proposal ids, gate words), not something a learner should read. The companion strips the block
// from the shown text and says the same thing plainly: how many suggestions went to the inbox.

const BLOCK =
  /\n*<!--copilot-proposal-disclosure:start-->([\s\S]*?)<!--copilot-proposal-disclosure:end-->\s*$/;
const ROW = /^- `[^`]+`(?:: status=([^,\n]+))?/;

export interface ProposalDisclosure {
  /** The reply text without the disclosure block. */
  text: string;
  /** Suggestions that now wait in the inbox (0 when none could be accepted). */
  pending: number;
  /** A disclosure block was present. */
  disclosed: boolean;
}

export function splitProposalDisclosure(reply: string): ProposalDisclosure {
  const match = BLOCK.exec(reply);
  if (!match) return { text: reply, pending: 0, disclosed: false };
  const lines = match[1].split('\n');
  let pending = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const row = ROW.exec(lines[i]);
    if (!row) continue;
    const status = row[1]?.trim();
    // A row is followed by its own notes; a 「未产生」 note marks it as not created.
    let created = status !== undefined && status !== 'failed' && !status.startsWith('skipped:');
    for (let j = i + 1; j < lines.length && lines[j].startsWith('  '); j += 1) {
      if (lines[j].includes('未产生')) created = false;
    }
    if (created) pending += 1;
  }
  return { text: reply.slice(0, match.index).trimEnd(), pending, disclosed: true };
}
