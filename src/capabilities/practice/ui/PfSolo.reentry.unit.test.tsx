// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { SaveResponseDraftBodySchema } from '../api/assessment-contracts';
import { PfSolo } from './PfSolo';
import type { StreamItem, getIssuanceState } from './practice-api';

type IssuanceState = Awaited<ReturnType<typeof getIssuanceState>>;
const issuanceId = 'iss_stream_reentry';
const queryKey = ['practice-issuance', issuanceId, 'auto_score'];
const issuedAt = '2026-10-06T10:00:00.000Z';
const item: StreamItem = {
  id: 'reentry',
  position: 0,
  item_kind: 'question',
  ref_id: 'derivative',
  source: 'decay',
  reasoning: '比较平均变化率与瞬时变化率。',
  status: 'pending',
  estimated_minutes: 4,
  knowledge_name: '导数与极限',
  paper_title: null,
  verdict: null,
  completed_at: null,
  total_slots: null,
};
const question = {
  id: 'derivative',
  kind: 'short',
  prompt_md: '比较差商与导数，并说明不可导边界。',
  reference_md: null,
  choices_md: null,
  labels: [{ id: 'limits', name: '导数与极限' }],
  source: 'manual',
  committed_attempt: null,
  timeline: [],
};
const finalAnswer = `${'差商 [f(x+h)-f(x)]/h 是平均变化率；极限不存在时不可直接写导数。\n分段函数需要分别检查左右极限，保留条件与原始符号。\n'.repeat(32)}原文 {nested:[{b:"<> &"}]}；组合音 é；emoji 🧪。\nEND·最后字节·🧪`;

function responseSet(text: string): NonNullable<IssuanceState['draft']>['response_set'] {
  return {
    entries: [
      { slot_id: 'explanation', kind: 'text', text_md: text },
      {
        slot_id: 'boundary',
        kind: 'text',
        text_md: '反例 f(x)=|x|，左右极限分别为 −1 与 +1。\n不能合并为 0。',
      },
    ],
  };
}
const groupEvidence: NonNullable<IssuanceState['draft']>['group_evidence'] = [
  {
    evidence: {
      evidence_id: 'original_work',
      kind: 'image',
      asset: { asset_id: 'original_work', digest: `sha256:${'a'.repeat(64)}` },
      mime_type: 'image/png',
      bytes: 2048,
      uploaded_at: issuedAt,
    },
    target: { scope: 'units', scoring_unit_ids: ['unit_explanation', 'unit_boundary'] },
  },
];
function draft(text: string, epoch: number): NonNullable<IssuanceState['draft']> {
  return {
    evaluation_group_ref: 'group_stream_reentry',
    response_set: responseSet(text),
    group_evidence: groupEvidence,
    save_epoch: epoch,
    updated_at: issuedAt,
  };
}
function state(initialDraft: IssuanceState['draft']): IssuanceState {
  return {
    issuance: {
      issuance_id: issuanceId,
      issued_at: issuedAt,
      binding: {
        revision_id: 'revision_pinned',
        part_ids: ['derivative'],
        material_bindings: [],
        option_order: [],
      },
      claim: { policy: 'unbounded', status: 'unclaimed', claimed_by_ref: null },
    },
    practice_dto: {
      issuance_id: issuanceId,
      revision_id: 'revision_pinned',
      issued_at: issuedAt,
      materials: [
        {
          material_id: 'passage',
          kind: 'passage',
          asset_id: 'passage_pinned',
          content_md: '设增量 h≠0。讨论 h→0 时差商的极限；左右极限不一致时，保留失败结论。',
        },
      ],
      faces: [{ part_id: 'derivative', prompt_md: question.prompt_md, material_ids: ['passage'] }],
      response_spec: {
        slots: [
          {
            slot_id: 'explanation',
            part_id: 'derivative',
            kind: 'text',
            placement: { label: '解释' },
            math_preview: false,
          },
          {
            slot_id: 'boundary',
            part_id: 'derivative',
            kind: 'text',
            placement: { label: '边界' },
            math_preview: false,
          },
        ],
      },
      response_requirements: [
        { slot_id: 'explanation', evidence_unit_ids: ['unit_explanation'] },
        { slot_id: 'boundary', evidence_unit_ids: ['unit_boundary'] },
      ],
    },
    admission_generation_observed: 3,
    draft: initialDraft,
    submissions: [],
  };
}
function deferredResponse() {
  let resolve: (response: Response) => void = () => {
    throw new Error('response gate absent');
  };
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const clients: QueryClient[] = [];
function client(staleTime = 0) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime } } });
  clients.push(qc);
  return qc;
}
function mount(qc: QueryClient) {
  const onBack = vi.fn(() => view.unmount());
  const view = render(
    <QueryClientProvider client={qc}>
      <PfSolo
        item={item}
        sessionId={null}
        pos={1}
        total={1}
        onDone={vi.fn()}
        onBack={onBack}
        onCommittedBack={vi.fn()}
        addToast={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { ...view, onBack };
}
function readSave(init?: RequestInit) {
  if (typeof init?.body !== 'string') throw new Error('draft request body absent');
  return SaveResponseDraftBodySchema.parse(JSON.parse(init.body));
}
function ack(epoch: number) {
  return Response.json({
    status: 'saved',
    issuance_id: issuanceId,
    save_epoch: epoch,
    updated_at: issuedAt,
  });
}
beforeEach(() => {
  const storage = new Map<string, string>();
  const localStorage: Storage = {
    get length() {
      return storage.size;
    },
    clear: () => storage.clear(),
    getItem: (key) => storage.get(key) ?? null,
    key: (index) => [...storage.keys()][index] ?? null,
    removeItem: (key) => {
      storage.delete(key);
    },
    setItem: (key, value) => {
      storage.set(key, value);
    },
  };
  Object.defineProperty(window, 'localStorage', { value: localStorage, configurable: true });
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
});
afterEach(() => {
  cleanup();
  for (const qc of clients.splice(0)) qc.clear();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('PfSolo same-page reentry with the real QueryClient (YUK-1047)', () => {
  it('keeps active local edits and the observed epoch through background reads and repeated CAS409', async () => {
    const qc = client();
    let server = state(draft('恢复的草稿，epoch 4。', 4));
    const saves: ReturnType<typeof readSave>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/responses')) {
          saves.push(readSave(init));
          return Response.json(
            { error: 'stale_draft', message: 'draft save epoch conflict' },
            { status: 409 },
          );
        }
        if (url.includes('/api/issuances/')) return Response.json(server);
        if (url.includes('/api/questions/')) return Response.json(question);
        return Response.json({});
      }),
    );
    const view = mount(qc);
    const answer = await screen.findByRole('textbox', { name: '解释' });
    fireEvent.change(answer, { target: { value: finalAnswer } });
    server = state(draft('另一标签页的新草稿，不能覆盖当前编辑。', 9));
    await act(async () => qc.refetchQueries({ queryKey, exact: true }));
    expect(qc.getQueryData<IssuanceState>(queryKey)?.draft?.save_epoch).toBe(9);
    expect(answer).toHaveProperty('value', finalAnswer);
    fireEvent.click(screen.getByRole('button', { name: '返回流' }));
    await screen.findByText('版本有更新 · 先刷新再改');
    expect(view.onBack).not.toHaveBeenCalled();
    expect(answer).toHaveProperty('value', finalAnswer);
    expect(answer).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: '返回流' }));
    await waitFor(() => expect(saves).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '返回流' })).toHaveProperty('disabled', false),
    );
    expect(saves.map((save) => save.expected_save_epoch)).toEqual([4, 4]);
    for (const save of saves) {
      expect(save.response_set.entries).toContainEqual({
        slot_id: 'explanation',
        kind: 'text',
        text_md: finalAnswer,
      });
      expect(save.group_evidence).toEqual(groupEvidence);
    }
    expect(view.onBack).not.toHaveBeenCalled();
  });

  it('does not open a stale cached draft when the fresh reentry GET fails', async () => {
    const qc = client();
    let fail = false;
    const saves = vi.fn(async () => ack(5));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/responses')) return saves();
        if (url.includes('/api/issuances/'))
          return fail
            ? Response.json(
                { error: 'temporarily_unavailable', message: '恢复失败，请重试' },
                { status: 503 },
              )
            : Response.json(state(draft('旧草稿不能作为重进后的可编辑基线。', 4)));
        if (url.includes('/api/questions/')) return Response.json(question);
        return Response.json({});
      }),
    );
    const first = mount(qc);
    await screen.findByRole('textbox', { name: '解释' });
    first.unmount();
    fail = true;
    mount(qc);
    await screen.findByText('恢复失败，请重试');
    expect(screen.queryByRole('textbox', { name: '解释' })).toBeNull();
    expect(saves).not.toHaveBeenCalled();
  });

  it('restores an accepted submission awaiting judgment ahead of a leftover live draft', async () => {
    const qc = client();
    const server: IssuanceState = {
      ...state(draft('未提交的旧草稿', 4)),
      submissions: [
        {
          submission_id: 'submission_stream_reentry',
          evaluation_group_id: 'group_stream_reentry',
          idempotency_key: 'submit_stream_reentry',
          submitted_at: issuedAt,
          response_set: responseSet(finalAnswer),
          group_evidence: groupEvidence,
        },
      ],
    };
    const saves = vi.fn(async () => ack(5));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/responses')) return saves();
        if (url.includes('/api/issuances/')) return Response.json(server);
        if (url.includes('/api/questions/')) return Response.json(question);
        return Response.json({});
      }),
    );
    const view = mount(qc);
    const answer = await screen.findByRole('textbox', { name: '解释' });
    await waitFor(() => expect(answer).toHaveProperty('value', finalAnswer));
    expect(answer).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '返回流' }));
    await waitFor(() => expect(view.onBack).toHaveBeenCalledOnce());
    expect(saves).not.toHaveBeenCalled();
  });

  it('keeps final B saving when submit is attempted while return awaits the older A ACK', async () => {
    const qc = client();
    const oldAck = deferredResponse();
    const finalAck = deferredResponse();
    const adviceFailure = deferredResponse();
    const saves: ReturnType<typeof readSave>[] = [];
    const advice = vi.fn(() => adviceFailure.promise);
    const upload = vi.fn(async () => Response.json({}));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/responses')) {
          saves.push(readSave(init));
          return saves.length === 1 ? oldAck.promise : finalAck.promise;
        }
        if (url.includes('/api/review/advice')) return advice();
        if (url.includes('/api/assets') && init?.method === 'POST') return upload();
        if (url.includes('/api/issuances/')) return Response.json(state(draft('已恢复基线', 4)));
        if (url.includes('/api/questions/')) return Response.json(question);
        return Response.json({});
      }),
    );
    const view = mount(qc);
    const answer = await screen.findByRole('textbox', { name: '解释' });
    fireEvent.change(answer, { target: { value: 'A：先写差商，尚未检查不可导边界。' } });
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 1500 });
    fireEvent.change(answer, { target: { value: finalAnswer } });
    fireEvent.click(screen.getByRole('button', { name: '返回流' }));
    fireEvent.click(screen.getByRole('button', { name: '提交 · 即时判分' }));
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await act(async () => oldAck.resolve(ack(5)));
    expect(view.onBack).not.toHaveBeenCalled();
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]?.expected_save_epoch).toBe(5);
    expect(saves[1]?.response_set.entries).toContainEqual({
      slot_id: 'explanation',
      kind: 'text',
      text_md: finalAnswer,
    });
    expect(advice).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '提交 · 即时判分' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('button', { name: '添加附件' })).toBeNull();
    await act(async () =>
      adviceFailure.resolve(Response.json({ error: 'not_received' }, { status: 503 })),
    );
    expect(view.onBack).not.toHaveBeenCalled();
    await act(async () => finalAck.resolve(ack(6)));
    await waitFor(() => expect(view.onBack).toHaveBeenCalledOnce());
  });

  it.each([
    { label: 'empty', initialDraft: null, staleTime: 0 },
    {
      label: 'older',
      initialDraft: draft('旧草稿：只写了平均变化率，尚未检查左右极限。', 4),
      staleTime: 0,
    },
    {
      label: 'fresh by cache age',
      initialDraft: draft('缓存尚未过期，但上次 ACK 已更新服务端。', 4),
      staleTime: 60_000,
    },
  ])(
    'restores final ACKed bytes and CAS epoch after unmount with $label cached draft',
    async ({ initialDraft, staleTime }) => {
      const qc = client(staleTime);
      let server = state(initialDraft);
      let reads = 0;
      const freshGet = deferredResponse();
      const finalAck = deferredResponse();
      const saves: ReturnType<typeof readSave>[] = [];
      const savedEpoch = (initialDraft?.save_epoch ?? 0) + 1;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith('/responses')) {
            const body = readSave(init);
            saves.push(body);
            server = {
              ...server,
              draft: {
                ...draft(finalAnswer, savedEpoch),
                response_set: body.response_set,
                group_evidence: body.group_evidence,
              },
            };
            return saves.length === 1 ? finalAck.promise : ack(savedEpoch + 1);
          }
          if (url.includes('/api/issuances/')) {
            reads += 1;
            return reads === 2 ? freshGet.promise : Response.json(server);
          }
          if (url.includes('/api/questions/')) return Response.json(question);
          return Response.json({});
        }),
      );
      const first = mount(qc);
      fireEvent.change(await screen.findByRole('textbox', { name: '解释' }), {
        target: { value: finalAnswer },
      });
      fireEvent.change(screen.getByRole('textbox', { name: '边界' }), {
        target: { value: '左右极限不一致，不能取平均。' },
      });
      fireEvent.click(screen.getByRole('button', { name: '返回流' }));
      await waitFor(() => expect(saves).toHaveLength(1));
      expect(first.onBack).not.toHaveBeenCalled();
      expect(saves[0]?.expected_save_epoch).toBe(initialDraft?.save_epoch);
      await act(async () => finalAck.resolve(ack(savedEpoch)));
      await waitFor(() => expect(first.onBack).toHaveBeenCalledOnce());

      const second = mount(qc);
      await waitFor(() => expect(reads).toBe(2));
      // A new answering session cannot expose the stale cached draft as editable input.
      const cachedAnswer = screen.queryByRole('textbox', { name: '解释' });
      await act(async () => freshGet.resolve(Response.json(server)));
      const answer = await screen.findByRole('textbox', { name: '解释' });
      await waitFor(() =>
        expect(qc.getQueryData<IssuanceState>(queryKey)?.draft?.save_epoch).toBe(savedEpoch),
      );
      await waitFor(() => expect(answer).toHaveProperty('value', finalAnswer));
      expect(cachedAnswer).toBeNull();
      expect(screen.getByRole('textbox', { name: '边界' })).toHaveProperty(
        'value',
        '左右极限不一致，不能取平均。',
      );
      const nextAnswer = `${finalAnswer}\n重新进入后追加的最后字节 Ω🧪`;
      fireEvent.change(answer, { target: { value: nextAnswer } });
      fireEvent.click(screen.getByRole('button', { name: '返回流' }));
      await waitFor(() => expect(second.onBack).toHaveBeenCalledOnce());
      expect(saves).toHaveLength(2);
      expect(saves[1]?.expected_save_epoch).toBe(savedEpoch);
      expect(saves[1]?.response_set.entries).toContainEqual({
        slot_id: 'explanation',
        kind: 'text',
        text_md: nextAnswer,
      });
      expect(saves[1]?.group_evidence).toEqual(initialDraft ? groupEvidence : []);
    },
  );
});
