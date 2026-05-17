'use client';

// Phase 2C — Active Teaching chat page.
//
// /learn/[learning_item_id]/chat
//   - On mount, POST /api/teaching-sessions { learning_item_id } to create
//     a fresh conversation session.
//   - Renders message stream (agent ↔ user) of experimental:teach_message
//     events for the session.
//   - Input box → POST /api/teaching-sessions/[id]/turn { text_md }.
//   - "结束会话" button → POST /api/teaching-sessions/[id]/end and disables input.
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

interface ChatMessage {
  id: string;
  role: 'agent' | 'user';
  text_md: string;
  turn_kind: 'explain' | 'ask_check' | 'end' | null;
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

  const onSend = () => {
    const text = draft.trim();
    if (!text || turnM.isPending || ended) return;
    turnM.mutate(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '36px 28px',
        maxWidth: 'var(--cap-prose, 780px)',
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

      <div className="teach-chat-page" style={{ marginTop: 'var(--s-4)' }}>
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
            <div className="teach-chat-meta">
              <span>session={sessionId}</span>
              {ended ? <span style={{ color: 'var(--again-ink)' }}>· 已结束</span> : null}
            </div>

            <div className="teach-chat-stream">
              {messages.map((m) => (
                <div key={m.id} className={`teach-msg ${m.role}`}>
                  {m.role === 'agent' && m.turn_kind && (
                    <span className="turn-kind">[{m.turn_kind}]</span>
                  )}
                  {m.text_md}
                </div>
              ))}
              {turnM.isPending && (
                <div className="teach-msg agent" style={{ opacity: 0.6 }}>
                  …
                </div>
              )}
            </div>

            {ended ? (
              <div className="teach-chat-end-banner">
                会话已结束。下次需要时刷新页面开启新对话。
              </div>
            ) : (
              <>
                <div className="teach-chat-input">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="说点什么…（⌘/Ctrl+Enter 发送）"
                    disabled={turnM.isPending}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Button onClick={onSend} disabled={!draft.trim() || turnM.isPending}>
                      发送
                    </Button>
                    <Button onClick={() => endM.mutate()} disabled={endM.isPending} variant="ghost">
                      结束
                    </Button>
                  </div>
                </div>
                <div className="teach-chat-footer">
                  {suggestedNext === 'end' ? '教练建议结束 — 你可继续追问或点结束。' : ''}
                  {turnM.isError ? (
                    <span style={{ color: 'var(--again-ink)' }}>
                      发送失败：{(turnM.error as Error)?.message}
                    </span>
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
