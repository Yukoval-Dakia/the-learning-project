// A knowledge or note card placed in a reply: the block holds only the id, and this reads what the
// card shows. A target that is gone is an answer, not a failure, and has nothing to open.
import { useQuery } from '@tanstack/react-query';
import type { EntityCardSlotProps } from '@/ui/components/blocks/entity-card-slot';
import { Button } from '@/ui-next/public';
import { useCopilotClient } from '../copilot-client';
import { KnowledgeCard, NoteCard } from './ReplyCards';

const OUTCOME_WORDS = { correct: '做对了', partial: '部分对', wrong: '没做对' } as const;
const GONE_WORDS = { knowledge: '这个知识点已经不在了。', note: '这条笔记已经不在了。' } as const;

function shortDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function EntityCard({
  entityKind,
  entityId,
  navigate,
}: EntityCardSlotProps & { navigate: (to: string) => void }) {
  const { getEntityCard } = useCopilotClient();
  const card = useQuery({
    queryKey: ['entity-card', entityKind, entityId],
    queryFn: () => getEntityCard(entityKind, entityId),
  });
  if (card.isPending) {
    return (
      <output className="un-cp-block un-cp-block-gone" aria-live="polite">
        正在读取…
      </output>
    );
  }
  if (card.isError) {
    return (
      <div className="un-cp-block un-cp-block-gone">
        这张卡现在读不出来。
        <div className="un-cp-block-actions">
          <Button size="sm" variant="secondary" onClick={() => void card.refetch()}>
            再试一次
          </Button>
        </div>
      </div>
    );
  }
  const data = card.data;
  if (data.state === 'gone') {
    return <div className="un-cp-block un-cp-block-gone">{GONE_WORDS[data.entity_kind]}</div>;
  }
  const encoded = encodeURIComponent(data.entity_id);
  if (data.entity_kind === 'knowledge') {
    const practice = data.last_practice;
    return (
      <KnowledgeCard
        name={data.name}
        band={data.mastery_band}
        lastPractice={
          practice
            ? [shortDate(practice.at), practice.outcome ? OUTCOME_WORDS[practice.outcome] : null]
                .filter(Boolean)
                .join(' ')
            : null
        }
        onOpen={() => navigate(`/knowledge/${encoded}`)}
      />
    );
  }
  return (
    <NoteCard
      title={data.title}
      summary={data.summary}
      updated={`${shortDate(data.updated_at)} `}
      onOpen={() => navigate(`/notes/${encoded}`)}
    />
  );
}
