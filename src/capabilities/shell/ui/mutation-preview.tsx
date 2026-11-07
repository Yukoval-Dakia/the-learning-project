// What a proposed change to the knowledge tree acts on, in names and states read from the server.
import { ArrowRight } from 'lucide-react';
import type { ProposalInboxRow } from './inbox-api';

type MutationPresentation = NonNullable<
  NonNullable<ProposalInboxRow['presentation']>['knowledge_mutation']
>;
type NodeLabel = Extract<MutationPresentation, { mutation: 'merge' }>['into'];

const STATE_WORDS: Readonly<Record<Exclude<NodeLabel['state'], 'live' | 'missing'>, string>> = {
  archived: '已归档',
  merged: '已并到别处',
};

function nodesOf(mutation: MutationPresentation): NodeLabel[] {
  switch (mutation.mutation) {
    case 'merge':
      return [...mutation.from, mutation.into];
    case 'reparent':
      return mutation.parent ? [mutation.node, mutation.parent] : [mutation.node];
    case 'split':
      return [
        mutation.from,
        ...mutation.into.flatMap((piece) => (piece.parent ? [piece.parent] : [])),
      ];
  }
}

/** Every node has a name, so the card can be read without its reason. */
export function mutationFullyNamed(mutation: MutationPresentation): boolean {
  return nodesOf(mutation).every((node) => node.label !== null);
}

const BLOCKED_WORDS: Readonly<Record<NonNullable<MutationPresentation['blocked']>, string>> = {
  to_top: '它要把知识点放到最顶层，现在还不支持。可以忽略这张。',
  // The read may have failed, so this does not say the node was deleted.
  node_unreadable: '有知识点现在找不到，也可能只是暂时读不到。可以过会儿再看，或者忽略这张。',
  node_retired: '有知识点已经归档或并到别处了，这张用不上了，可以忽略。',
  version_changed: '这个知识点后来改过，这张建议可能过时了，可以忽略。',
};

/** The server decides whether this can run; these are the words for its answer. */
export function mutationBlockedWords(mutation: MutationPresentation): string | null {
  return mutation.blocked ? BLOCKED_WORDS[mutation.blocked] : null;
}

function Node({ node }: { node: NodeLabel }) {
  if (node.label === null) {
    return (
      <span className="ib-edge-node" data-off="">
        找不到这个知识点
      </span>
    );
  }
  return (
    <span className="ib-edge-node" data-off={node.state === 'live' ? undefined : ''}>
      {node.label}
      {node.state === 'archived' || node.state === 'merged'
        ? ` · ${STATE_WORDS[node.state]}`
        : null}
    </span>
  );
}

/** A piece's parent is shown only when it is what stops the card. */
function pieceParentWords(parent: NodeLabel | null): string | null {
  if (parent === null) return '放到最顶层';
  if (parent.state === 'missing') return '上级找不到';
  return parent.state === 'live' ? null : `上级${STATE_WORDS[parent.state]}`;
}

function Arrow() {
  return <ArrowRight size={14} aria-hidden="true" className="ib-edge-arrow" />;
}

export function MutationPreview({ mutation }: { mutation: MutationPresentation }) {
  switch (mutation.mutation) {
    case 'merge':
      return (
        <div className="ib-edge">
          <span className="ib-kicker">并走</span>
          {mutation.from.map((node, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, and two nodes can share a name or have none.
            <Node key={index} node={node} />
          ))}
          <Arrow />
          <span className="ib-kicker">留下</span>
          <Node node={mutation.into} />
        </div>
      );
    case 'reparent':
      return (
        <div className="ib-edge">
          <span className="ib-kicker">移动</span>
          <Node node={mutation.node} />
          <Arrow />
          <span className="ib-kicker">放到</span>
          {mutation.parent ? <Node node={mutation.parent} /> : <span>最顶层</span>}
        </div>
      );
    case 'split':
      return (
        <div className="ib-edge">
          <span className="ib-kicker">拆开</span>
          <Node node={mutation.from} />
          <Arrow />
          <span className="ib-kicker">拆成</span>
          {mutation.into.map((piece, index) => {
            const note = pieceParentWords(piece.parent);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, and two pieces can share a name.
              <span key={index} className="ib-edge-node" data-off={note ? '' : undefined}>
                {piece.name}
                {note ? ` · ${note}` : null}
              </span>
            );
          })}
        </div>
      );
  }
}
