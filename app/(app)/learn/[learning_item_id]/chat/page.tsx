'use client';

// Phase 2C — Active Teaching chat page.
//
// /learn/[learning_item_id]/chat
//   - On mount, POST /api/teaching-sessions { learning_item_id } to create
//     a fresh conversation session.
//   - Renders message stream (agent ↔ user) of experimental:teach_message
//     events for the session, using the v2.1 design vocabulary
//     (.msg / .actor-line / .body / .composer / .suggest-chip).
//   - Input box → POST /api/teaching-sessions/[id]/turn { text_md }.
//   - 结束 button → POST /api/teaching-sessions/[id]/end and disables input.
//
// MVP: 1 session per page mount. Refresh = new session. History view lives
// elsewhere (Phase 3 timeline).

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

type TurnKind = 'explain' | 'ask_check' | 'end';

interface ChatMessage {
  id: string;
  role: 'agent' | 'user';
  text_md: string;
  turn_kind: TurnKind | null;
}

interface StartResponse {
  session_id: string;
  initial_message: ChatMessage;
  suggested_next: 'continue' | 'end';
}

interface TurnResponse {
  user_message: ChatMessage;
  agent_message: ChatMessage;
  suggested_next: 'continue' | 'end';
}

const TURN_KIND_LABEL: Record<TurnKind, string> = {
  explain: '讲解',
  ask_check: '追问',
  end: '收尾',
};

const SUGGESTIONS = [
  { label: '再讲一遍', text: '上一段没完全跟上，能不能换一种说法再讲一遍？' },
  { label: '出题考我', text: '出一道相关的题考我一下。' },
  { label: '我懂了', text: '我懂了，继续下一个要点吧。' },
];

export default function TeachChatPage() {
  const params = useParams<{ learning_item_id: string }>();
  const learningItemId = params.learning_item_id;

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [suggestedNext, setSuggestedNext] = useState<'continue' | 'end'>('continue');
  const [draft, setDraft] = useState('');
  const [ended, setEnded] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const startCalledRef = useRef(false);
  const streamRef = useRef<HTMLDivElement | null>(null);

  // Start the session once on mount.
  useEffect(() => {
    if (!learningItemId || startCalledRef.current) return;
    startCalledRef.current = true;
    (async () => {
      try {
        const res = await apiJson<StartResponse>('/api/teaching-sessions', {
          method: 'POST',
          body: JSON.stringify({ learning_item_id: learningItemId }),
        });
        setSessionId(res.session_id);
        setMessages([res.initial_message]);
        setSuggestedNext(res.suggested_next);
        if (res.initial_message.turn_kind === 'end') setEnded(true);
      } catch (err) {
        if (err instanceof ApiAuthError) {
          setBootError(`${err.message} — 请重新进入页面输入 token`);
        } else {
          setBootError(`无法开启教学会话：${(err as Error).message}`);
        }
      }
    })();
  }, [learningItemId]);

  const turnM = useMutation({
    mutationFn: async (text_md: string) => {
      if (!sessionId) throw new Error('session not ready');
      return apiJson<TurnResponse>(`/api/teaching-sessions/${sessionId}/turn`, {
        method: 'POST',
        body: JSON.stringify({ text_md }),
      });
    },
    onSuccess: (data) => {
      setMessages((prev) => [...prev, data.user_message, data.agent_message]);
      setSuggestedNext(data.suggested_next);
      if (data.agent_message.turn_kind === 'end') setEnded(true);
      setDraft('');
    },
  });

  const endM = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('session not ready');
      return apiJson<{ ok: boolean }>(`/api/teaching-sessions/${sessionId}/end`, {
        method: 'POST',
      });
    },
    onSuccess: () => setEnded(true),
  });

  // Auto-scroll on each new bubble / typing toggle. Read both inputs inside
  // the effect so biome's exhaustive-deps rule accepts them as observed state.
  const msgCount = messages.length;
  const isTyping = turnM.isPending;
  useEffect(() => {
    void msgCount;
    void isTyping;
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgCount, isTyping]);

  const send = (text: string) => {
    if (!text.trim() || turnM.isPending || ended) return;
    turnM.mutate(text.trim());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(draft);
    }
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '36px 28px',
        maxWidth: 'var(--cap-prose, 720px)',
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <PageHeader title="对话教学" eyebrow={`/learn/${learningItemId}/chat`} />
      <div style={{ marginTop: 'var(--s-2)' }}>
        <Link
          href={`/learning-items/${learningItemId}`}
          style={{ color: 'var(--coral)', textDecoration: 'none' }}
        >
          ← 返回学习项
        </Link>
      </div>

      <div className="teach-chat-page" style={{ marginTop: 'var(--s-6)' }}>
        {bootError && (
          <Card>
            <p style={{ margin: 0, color: 'var(--again-ink)' }}>{bootError}</p>
          </Card>
        )}

        {!bootError && !sessionId && (
          <Card>
            <p style={{ margin: 0, color: 'var(--ink-3)' }}>正在开启会话…</p>
          </Card>
        )}

        {sessionId && (
          <>
            <div className={`session-banner${ended ? ' ended' : ''}`}>
              ── learning_session(type='conversation'
              {ended ? ', status=ended' : ', status=active'}) ──
            </div>

            <div className="msg-stream" ref={streamRef}>
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  <div className="actor-line">
                    <span>{m.role === 'agent' ? 'agent · TeachingTurnTask' : 'user · self'}</span>
                    {m.turn_kind && <span>· {TURN_KIND_LABEL[m.turn_kind]}</span>}
                  </div>
                  <div className="body">{m.text_md}</div>
                </div>
              ))}
              {turnM.isPending && (
                <div className="msg agent">
                  <div className="actor-line">
                    <span>agent · TeachingTurnTask</span>
                    <span>· 思考中…</span>
                  </div>
                  <div className="typing">
                    <span className="dot" />
                    <span className="dot" style={{ animationDelay: '0.2s' }} />
                    <span className="dot" style={{ animationDelay: '0.4s' }} />
                  </div>
                </div>
              )}
            </div>

            {ended ? (
              <div className="end-banner">会话已结束。下次需要时刷新页面开启新对话。</div>
            ) : (
              <>
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      className="suggest-chip"
                      onClick={() => send(s.text)}
                      disabled={turnM.isPending}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                <div className="composer">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
                    disabled={turnM.isPending}
                    rows={2}
                  />
                  <div className="actions">
                    <Button onClick={() => send(draft)} disabled={!draft.trim() || turnM.isPending}>
                      发送
                    </Button>
                    <Button onClick={() => endM.mutate()} disabled={endM.isPending} variant="ghost">
                      结束
                    </Button>
                  </div>
                </div>

                <div className="footer-line">
                  <span>
                    {suggestedNext === 'end' ? (
                      <span className="hint">教练建议结束 — 可继续追问或点结束</span>
                    ) : (
                      <span>session={sessionId.slice(0, 8)}…</span>
                    )}
                  </span>
                  {turnM.isError ? (
                    <span className="error">发送失败：{(turnM.error as Error)?.message}</span>
                  ) : null}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
