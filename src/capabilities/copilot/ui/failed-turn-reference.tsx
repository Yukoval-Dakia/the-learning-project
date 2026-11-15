import { type ComponentType, useCallback, useRef, useState } from 'react';
import { ApiError, type ApiOperationJsonResponse, apiJson } from '@/ui/lib/api';
import { Button } from '@/ui-next/public';
import {
  FailedTurnPracticeTarget,
  type FailedTurnPracticeTargetT,
} from '../failed-turn-practice-target-contract';
import { ConversationMarkdown } from './companion/ConversationMarkdown';

export interface FailedTurnReferenceProps {
  runId: string;
  sessionId: string;
  disabled: boolean;
}

export type FailedTurnReferenceRenderer = ComponentType<FailedTurnReferenceProps>;

export interface FailedTurnReferenceClient {
  readTarget(runId: string, sessionId: string): Promise<FailedTurnPracticeTargetT>;
  revealReference(issuanceId: string): Promise<{ reference_md: string | null }>;
  restoreHints(
    questionId: string,
    issuanceId: string,
  ): Promise<ApiOperationJsonResponse<'restoreHintHistory'>>;
}

export async function readCopilotFailedTurnPracticeTarget(
  runId: string,
  sessionId: string,
): Promise<FailedTurnPracticeTargetT> {
  return FailedTurnPracticeTarget.parse(
    await apiJson<unknown>(
      `/api/copilot/runs/${encodeURIComponent(runId)}/practice-target?session_id=${encodeURIComponent(sessionId)}`,
      { cache: 'no-store' },
    ),
  );
}

type ReferenceView =
  | { status: 'idle' | 'loading' | 'empty' }
  | { status: 'unavailable' | 'unknown'; message: string }
  | {
      status: 'ready';
      target: Extract<FailedTurnPracticeTargetT, { status: 'ready' }>;
      markdown: string;
    };

type HintHistoryView =
  | { status: 'idle' | 'loading' }
  | { status: 'unavailable' | 'unknown'; message: string }
  | {
      status: 'received';
      target: Extract<FailedTurnPracticeTargetT, { status: 'ready' }>;
      history: ApiOperationJsonResponse<'restoreHintHistory'>;
    };

function unavailableMessage(
  reason: Extract<FailedTurnPracticeTargetT, { status: 'unavailable' }>['reason'],
  action = '查看封存参考',
) {
  switch (reason) {
    case 'no_saved_practice_target':
      return `这次提问没有可确认的原题记录，无法${action}。`;
    case 'revoked':
      return `原提问或这次作答已不可用于${action}。`;
    case 'outcome_unknown':
      return `这次求助的结果尚未确认，暂不能从这里${action}。`;
    default:
      return `这次求助目前不能从这里${action}。`;
  }
}

/** Only an explicit click resolves the original target and invokes its injected material owner. */
export function FailedTurnReference({
  runId,
  sessionId,
  disabled,
  client,
}: FailedTurnReferenceProps & { client: FailedTurnReferenceClient }) {
  const [view, setView] = useState<ReferenceView>({ status: 'idle' });
  const [hintView, setHintView] = useState<HintHistoryView>({ status: 'idle' });
  const inFlight = useRef(false);
  const lifetime = useRef(0);
  const attach = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    return () => {
      lifetime.current += 1;
    };
  }, []);

  async function readMaterial(material: 'reference' | 'hints') {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    const activeLifetime = lifetime.current;
    let requestedMaterial = false;
    if (material === 'hints') setHintView({ status: 'loading' });
    else setView({ status: 'loading' });
    try {
      const target = await client.readTarget(runId, sessionId);
      // Leaving this message during its GET must not start a later disclosure/restoration POST.
      if (lifetime.current !== activeLifetime) return;
      if (target.status === 'unavailable') {
        const next: { status: 'unavailable'; message: string } = {
          status: 'unavailable',
          message: unavailableMessage(
            target.reason,
            material === 'hints' ? '恢复已发布提示' : '查看封存参考',
          ),
        };
        if (material === 'hints') setHintView(next);
        else setView(next);
        return;
      }
      requestedMaterial = true;
      if (material === 'hints') {
        const history = await client.restoreHints(target.question_id, target.issuance_id);
        if (lifetime.current !== activeLifetime) return;
        setHintView({ status: 'received', target, history });
        return;
      }
      const result = await client.revealReference(target.issuance_id);
      if (lifetime.current !== activeLifetime) return;
      if (result.reference_md === null) setView({ status: 'empty' });
      else if (typeof result.reference_md === 'string' && result.reference_md.trim())
        setView({ status: 'ready', target, markdown: result.reference_md });
      else
        setView({
          status: 'unknown',
          message: '参考内容未能确认，可能已经记录援助。不会自动再次请求。',
        });
    } catch (error) {
      if (lifetime.current !== activeLifetime) return;
      const denied =
        error instanceof ApiError &&
        (error.status === 403 ||
          error.status === 404 ||
          [
            'coordinate_mismatch',
            'reveal_unavailable',
            'study_restricted',
            'study_source_unknown',
            'study_source_restricted',
            'hint_history_invalid',
          ].includes(error.code ?? ''));
      const next: { status: 'unavailable' | 'unknown'; message: string } = denied
        ? {
            status: 'unavailable',
            message:
              material === 'hints'
                ? '原题的已发布提示暂不可恢复，未显示提示内容。'
                : '原题参考已不可用，未显示参考内容。',
          }
        : {
            status: 'unknown',
            message: requestedMaterial
              ? material === 'hints'
                ? '这次恢复的结果尚未确认，可能已经记录援助。不会自动再次请求。'
                : '这次查看的结果尚未确认，可能已经记录援助。不会自动再次请求。'
              : material === 'hints'
                ? '暂时无法确认原题提示入口，尚未发起恢复提示的请求。'
                : '暂时无法确认原题参考入口，尚未发起查看参考的请求。',
          };
      if (material === 'hints') setHintView(next);
      else setView(next);
    } finally {
      inFlight.current = false;
    }
  }

  const loading = view.status === 'loading' || hintView.status === 'loading';
  const history = hintView.status === 'received' ? hintView.history : undefined;
  return (
    <section ref={attach} aria-label="原题的已保存帮助">
      <p className="un-cp-reply-status">恢复已发布提示可能记入援助；已提交的作答回执保留原记录。</p>
      {hintView.status === 'idle' ||
      hintView.status === 'loading' ||
      hintView.status === 'unknown' ||
      history?.status === 'outcome_unknown' ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || loading}
          onClick={() => void readMaterial('hints')}
        >
          {hintView.status === 'loading'
            ? '正在核对并恢复…'
            : hintView.status === 'unknown' || history?.status === 'outcome_unknown'
              ? '再次恢复已发布提示（记援助）'
              : '恢复已发布提示（记援助）'}
        </Button>
      ) : null}
      {hintView.status === 'unavailable' || hintView.status === 'unknown' ? (
        <p className="un-cp-reply-status" role="status">
          {hintView.message}
        </p>
      ) : null}
      {hintView.status === 'received' ? (
        <>
          <p className="un-cp-reply-status" role="status">
            {hintView.history.status === 'ready'
              ? '已恢复这次作答可用的已发布提示。'
              : hintView.history.status === 'empty'
                ? '没有可恢复的已发布提示。'
                : hintView.history.status === 'legacy_body_unavailable'
                  ? '存在旧提示使用记录，但部分正文无法恢复；这里只展示已确认发布的部分。'
                  : '仍有提示结果未确认；这里只展示已发布部分，不会自动再次请求恢复。'}
          </p>
          {hintView.history.hints.length > 0 ? (
            <p className="un-cp-reply-status">
              已发布提示 · 出处：原提问对应的这次作答 ·{' '}
              <a href={`/questions/${encodeURIComponent(hintView.target.question_id)}`}>原题</a>
            </p>
          ) : null}
          {hintView.history.hints.map((hint) => (
            <div key={hint.index}>
              <p className="un-cp-reply-status">
                提示 {hint.index + 1} ·{' '}
                {hint.kind === 'ai' ? '已发布的模型提示' : '已发布的确定性下一步'}
              </p>
              <ConversationMarkdown className="un-cp-md">{hint.text_md}</ConversationMarkdown>
              {hint.disclosure_md ? (
                <ConversationMarkdown className="un-cp-reply-status">
                  {hint.disclosure_md}
                </ConversationMarkdown>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
      <p className="un-cp-reply-status">查看参考会计入一次援助；已提交的作答回执保留原记录。</p>
      {view.status === 'idle' || view.status === 'unknown' || view.status === 'loading' ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || loading}
          onClick={() => void readMaterial('reference')}
        >
          {view.status === 'loading'
            ? '正在核对并读取…'
            : view.status === 'unknown'
              ? '再次查看已保存的完整参考'
              : '查看已保存的完整参考'}
        </Button>
      ) : null}
      {view.status === 'unavailable' || view.status === 'unknown' ? (
        <p className="un-cp-reply-status" role="status">
          {view.message}
        </p>
      ) : null}
      {view.status === 'empty' ? (
        <p className="un-cp-reply-status" role="status">
          这次发行没有封存完整参考。
        </p>
      ) : null}
      {view.status === 'ready' ? (
        <>
          <p className="un-cp-reply-status">
            封存参考 · 出处：原提问对应的这次作答 ·{' '}
            <a href={`/questions/${encodeURIComponent(view.target.question_id)}`}>原题</a>
          </p>
          <ConversationMarkdown className="un-cp-md">{view.markdown}</ConversationMarkdown>
        </>
      ) : null}
    </section>
  );
}
