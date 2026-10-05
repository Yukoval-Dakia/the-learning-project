// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupEvidenceT } from '@/core/schema/assessment';
import { ApiError } from '@/ui/lib/api';
import { placementQuestionFixture, placementStartFixture } from './placement-fixtures';
import ScreenPlacement from './ScreenPlacement';

const mocks = vi.hoisted(() => ({
  startPlacement: vi.fn(),
  getPlacementSession: vi.fn(),
  placementNext: vi.fn(),
  placementEnd: vi.fn(),
  submitProbeAnswer: vi.fn(),
  saveResponseDraft: vi.fn(),
  apiJson: vi.fn(),
}));
vi.mock('./placement-api', () => mocks);
vi.mock('@/capabilities/practice/ui/practice-api', async (actual) => ({
  ...(await actual<typeof import('@/capabilities/practice/ui/practice-api')>()),
  saveResponseDraft: mocks.saveResponseDraft,
}));
vi.mock('@/ui/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/ui/lib/api')>()),
  apiJson: mocks.apiJson,
}));
const original: GroupEvidenceT = {
  evidence: {
    evidence_id: 'original_pdf',
    kind: 'pdf',
    asset: { asset_id: 'asset_pdf', digest: 'sha256:original' },
    mime_type: 'application/pdf',
    bytes: 4096,
    uploaded_at: '2026-10-04T00:00:00.000Z',
  },
  target: { scope: 'units', scoring_unit_ids: ['unit_native'] },
};

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/placement?goal=goal_1');
  mocks.startPlacement.mockResolvedValue(placementStartFixture());
  mocks.saveResponseDraft.mockResolvedValue({ save_epoch: 1 });
  mocks.placementEnd.mockResolvedValue({ status: 'abandoned' });
  mocks.submitProbeAnswer.mockResolvedValue({ status: 'effective' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function open(navigate = vi.fn()) {
  render(<ScreenPlacement navigate={navigate} />);
  await screen.findByText('用一句话解释导数。');
  return navigate;
}

describe('placement native restoration and autosave', () => {
  it('hydrates the server draft before saving, preserving original evidence, targets and CAS epoch', async () => {
    const q = placementQuestionFixture();
    q.assessment.state.draft = {
      evaluation_group_ref: q.assessment.evaluation_group_id,
      response_set: {
        entries: [
          { kind: 'text', slot_id: 'native_text', text_md: '原始解释\n含长句、空格与边界条件。' },
        ],
      },
      group_evidence: [original],
      save_epoch: 7,
      updated_at: '2026-10-05T00:00:00.000Z',
    };
    mocks.startPlacement.mockResolvedValue(placementStartFixture(q));
    mocks.saveResponseDraft.mockResolvedValue({ save_epoch: 8 });
    await open();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '作答' }).value).toBe(
      q.assessment.state.draft.response_set.entries[0].kind === 'text'
        ? q.assessment.state.draft.response_set.entries[0].text_md
        : '',
    );
    expect(mocks.saveResponseDraft).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '作答' }), {
      target: { value: '新的解释\n保持原证据。' },
    });
    await waitFor(() => expect(mocks.saveResponseDraft).toHaveBeenCalled(), { timeout: 1500 });
    expect(mocks.saveResponseDraft).toHaveBeenCalledWith(
      'iss_placement_1',
      {
        response_set: {
          entries: [{ kind: 'text', slot_id: 'native_text', text_md: '新的解释\n保持原证据。' }],
        },
        group_evidence: [original],
        evaluation_group_ref: 'eg_placement_1',
        expected_save_epoch: 7,
      },
      { keepalive: false },
    );
    await screen.findByText('已保存');
  });

  it('shows conflict and does not overwrite until explicitly restoring the server state', async () => {
    mocks.saveResponseDraft.mockRejectedValue(new ApiError('stale', 409));
    const q = placementQuestionFixture();
    q.assessment.state.draft = {
      evaluation_group_ref: 'eg_placement_1',
      response_set: {
        entries: [{ kind: 'text', slot_id: 'native_text', text_md: '另一个窗口的答案' }],
      },
      group_evidence: [],
      save_epoch: 9,
      updated_at: '2026-10-05T00:00:00.000Z',
    };
    mocks.placementNext.mockResolvedValue({
      done: false,
      answeredCount: 0,
      sourcingNeeded: false,
      question: q,
    });
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: '作答' }), {
      target: { value: '本地答案' },
    });
    await screen.findByText('版本有更新 · 先刷新再改', {}, { timeout: 1500 });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '下一题' }).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /重新加载服务端草稿/ }));
    await waitFor(() =>
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '作答' }).value).toBe(
        '另一个窗口的答案',
      ),
    );
    expect(mocks.saveResponseDraft).toHaveBeenCalledTimes(1);
    expect(mocks.submitProbeAnswer).not.toHaveBeenCalled();
  });

  it('attempts pagehide flush without claiming saved or ending the active session', async () => {
    mocks.saveResponseDraft.mockImplementation(() => new Promise(() => {}));
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: '作答' }), {
      target: { value: '尚未确认' },
    });
    act(() => window.dispatchEvent(new Event('pagehide')));
    await waitFor(() => expect(mocks.saveResponseDraft).toHaveBeenCalled());
    expect(mocks.saveResponseDraft.mock.calls[0][2]).toEqual({ keepalive: true });
    expect(screen.queryByText('已保存')).toBeNull();
    expect(mocks.placementEnd).not.toHaveBeenCalled();
  });

  it('awaits save ACK and the end transition before explicit exit', async () => {
    let ack!: (result: { save_epoch: number }) => void;
    let ended!: (result: unknown) => void;
    mocks.saveResponseDraft.mockImplementation(
      () =>
        new Promise((resolve) => {
          ack = resolve;
        }),
    );
    mocks.placementEnd.mockImplementation(
      () =>
        new Promise((resolve) => {
          ended = resolve;
        }),
    );
    const navigate = await open();
    fireEvent.change(screen.getByRole('textbox', { name: '作答' }), {
      target: { value: '离开前保存' },
    });
    await userEvent.click(screen.getByRole('button', { name: '退出' }));
    expect(mocks.placementEnd).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => ack({ save_epoch: 1 }));
    await waitFor(() => expect(mocks.placementEnd).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => ended({ status: 'abandoned' }));
    expect(navigate).toHaveBeenCalledWith('/today');
  });

  it('restores an active session from the URL and never restarts a terminal session', async () => {
    window.history.replaceState({}, '', '/placement?goal=goal_1&session=placement_1');
    mocks.getPlacementSession.mockResolvedValue({
      id: 'placement_1',
      goal_id: 'goal_1',
      status: 'started',
      scope_knowledge_ids: ['kn_1'],
    });
    mocks.placementNext.mockResolvedValue({
      done: false,
      answeredCount: 3,
      sourcingNeeded: false,
      question: placementQuestionFixture(),
    });
    await open();
    expect(mocks.startPlacement).not.toHaveBeenCalled();
    expect(screen.getByText('4', { selector: 'b' })).toBeTruthy();
    cleanup();
    mocks.getPlacementSession.mockResolvedValue({
      id: 'placement_1',
      goal_id: 'goal_1',
      status: 'abandoned',
    });
    render(<ScreenPlacement navigate={vi.fn()} />);
    await screen.findByText('这次定位练习已结束');
    expect(mocks.placementNext).toHaveBeenCalledTimes(1);
    expect(mocks.startPlacement).not.toHaveBeenCalled();
  });

  it('submits frozen multiple-choice IDs and numeric raw input with auto-rating kept in the API adapter', async () => {
    const q = placementQuestionFixture();
    if (!q.assessment.state.practice_dto) throw new Error('fixture');
    q.assessment.state.practice_dto.response_spec.slots = [
      {
        kind: 'multi_choice',
        part_id: 'q1',
        slot_id: 'native_multi',
        min_select: 1,
        max_select: 3,
        options: [
          { option_id: 'opaque_a', label: '甲', text: '左极限' },
          { option_id: 'opaque_b', label: '乙', text: '右极限' },
          { option_id: 'opaque_c', label: '丙', text: '函数值' },
        ],
      },
      { kind: 'numeric', part_id: 'q1', slot_id: 'native_numeric', placement: { label: '数值' } },
    ];
    mocks.startPlacement.mockResolvedValue(placementStartFixture(q));
    mocks.placementNext.mockResolvedValue({ done: true, answeredCount: 1, reason: 'cap' });
    await open();
    await userEvent.click(screen.getByRole('button', { name: /左极限/ }));
    await userEvent.click(screen.getByRole('button', { name: /右极限/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '数值' }), {
      target: { value: ' 1.20e2 ' },
    });
    await userEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(mocks.submitProbeAnswer.mock.calls[0][0].assessment).toMatchObject({
      issuance_id: 'iss_placement_1',
      evaluation_group_id: 'eg_placement_1',
      submission_id: 'sub_placement_1',
      idempotency_key: 'key_placement_1',
      response_set: {
        entries: [
          { kind: 'choice', slot_id: 'native_multi', option_ids: ['opaque_a', 'opaque_b'] },
          { kind: 'numeric', slot_id: 'native_numeric', raw_input: ' 1.20e2 ', value: 120 },
        ],
      },
    });
  });

  it('waits on a stored pending receipt without resubmitting or selecting before terminal polling', async () => {
    const q = placementQuestionFixture();
    q.assessment.phase = 'pending';
    q.assessment.pending_run = { run_id: 'stored_run', poll_url: '/stored/poll' };
    q.assessment.state.submissions = [
      {
        submission_id: 'sub_placement_1',
        evaluation_group_id: 'eg_placement_1',
        idempotency_key: 'key_placement_1',
        submitted_at: '2026-10-05T00:00:00.000Z',
        response_set: {
          entries: [{ kind: 'text', slot_id: 'native_text', text_md: '已接收原文' }],
        },
        group_evidence: [original],
      },
    ];
    mocks.startPlacement.mockResolvedValue(placementStartFixture(q));
    mocks.apiJson.mockResolvedValue({
      run_id: 'stored_run',
      status: 'done',
      result: { status: 'effective' },
    });
    mocks.placementNext.mockResolvedValue({ done: true, answeredCount: 1, reason: 'cap' });
    await open();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '作答' }).disabled).toBe(true);
    expect(mocks.placementNext).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.placementNext).toHaveBeenCalledTimes(1), { timeout: 2500 });
    expect(mocks.apiJson).toHaveBeenCalledWith('/stored/poll');
    expect(mocks.submitProbeAnswer).not.toHaveBeenCalled();
    expect(mocks.saveResponseDraft).not.toHaveBeenCalled();
  });
  it('keeps a newer failed save dirty after an older ACK and carries the acknowledged epoch forward', async () => {
    let firstAck!: (result: { save_epoch: number }) => void;
    mocks.saveResponseDraft
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            firstAck = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('latest failed'));
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: '作答' }), {
      target: { value: 'first snapshot' },
    });
    await waitFor(() => expect(mocks.saveResponseDraft).toHaveBeenCalledTimes(1), {
      timeout: 1500,
    });
    fireEvent.change(screen.getByRole('textbox', { name: '作答' }), {
      target: { value: 'latest snapshot' },
    });
    await act(async () => firstAck({ save_epoch: 1 }));
    await screen.findByText('保存失败 · 重试');
    expect(screen.queryByText('已保存')).toBeNull();
    expect(mocks.saveResponseDraft.mock.calls[1][1]).toMatchObject({
      expected_save_epoch: 1,
      response_set: { entries: [{ text_md: 'latest snapshot' }] },
    });
  });

  it('handles an explicit save failure honestly and permits a deliberate discard before exit', async () => {
    mocks.saveResponseDraft.mockRejectedValue(new Error('save offline'));
    const navigate = await open();
    fireEvent.change(screen.getByRole('textbox', { name: '作答' }), {
      target: { value: 'unsaved original' },
    });
    await userEvent.click(screen.getByRole('button', { name: '退出' }));
    await screen.findByText(/退出前未能确认保存/);
    expect(navigate).not.toHaveBeenCalled();
    expect(mocks.placementEnd).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '放弃未保存修改并退出' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/today'));
    expect(mocks.placementEnd).toHaveBeenCalledTimes(1);
  });

  it('holds unsupported table controls with an explicit safe exit', async () => {
    const q = placementQuestionFixture();
    if (!q.assessment.state.practice_dto) throw new Error('fixture');
    q.assessment.state.practice_dto.response_spec.slots.push({
      kind: 'table',
      part_id: 'q1',
      slot_id: 'table',
      column_headers: ['测量'],
      row_labels: ['初始'],
      cells: [{ row: 0, col: 0, slot_id: 'native_text' }],
    });
    mocks.startPlacement.mockResolvedValue(placementStartFixture(q));
    const navigate = await open();
    await screen.findByText(/尚不支持的作答控件/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '下一题' }).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '退出' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/today'));
    expect(mocks.submitProbeAnswer).not.toHaveBeenCalled();
  });

  it('waits after a fresh 202 and never advances or resubmits while polling', async () => {
    mocks.submitProbeAnswer.mockResolvedValue({
      run_id: 'fresh_run',
      backfill: { poll_url: '/fresh/poll' },
      verdict: 'pending',
    });
    mocks.apiJson.mockImplementation(() => new Promise(() => {}));
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: '作答' }), {
      target: { value: 'accepted original' },
    });
    await userEvent.click(screen.getByRole('button', { name: '下一题' }));
    await screen.findByText('作答已接收 · 等待定位结果');
    expect(mocks.placementNext).not.toHaveBeenCalled();
    expect(mocks.submitProbeAnswer).toHaveBeenCalledTimes(1);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '作答' }).disabled).toBe(true);
    expect(screen.queryByText(/评分管道|对错结果/)).toBeNull();
  });
});
