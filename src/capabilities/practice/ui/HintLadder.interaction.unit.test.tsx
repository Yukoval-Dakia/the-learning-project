// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HintLadder } from './HintLadder';
import type { QuestionDetail } from './practice-api';
import { solveHint, solveStart } from './practice-api';

vi.mock('./practice-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./practice-api')>();
  return { ...original, solveStart: vi.fn(), solveHint: vi.fn() };
});

const solveStartMock = vi.mocked(solveStart);
const solveHintMock = vi.mocked(solveHint);

const question: QuestionDetail = {
  id: 'q-hint-return',
  kind: 'choice',
  prompt_md: '题干',
  reference_md: '完整解',
  choices_md: ['A', 'B'],
  difficulty: 2,
  labels: [],
};

afterEach(cleanup);

beforeEach(() => {
  solveStartMock.mockReset();
  solveHintMock.mockReset();
  solveStartMock.mockResolvedValue({ session_id: 'solve-session' });
  solveHintMock.mockResolvedValue({ text_md: '提示' } as never);
});

describe('HintLadder return-to-answer closes its host drawer (YUK-635)', () => {
  it('normal ladder: “我自己来 · 交还控制” calls the host close callback', async () => {
    const onReturn = vi.fn();
    render(<HintLadder open question={question} onReturnToAnswer={onReturn} />);

    await userEvent.click(screen.getByRole('button', { name: '我自己来 · 交还控制' }));

    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('generation failure escape also closes the host drawer', async () => {
    solveHintMock.mockRejectedValueOnce(new Error('offline'));
    const onReturn = vi.fn();
    render(<HintLadder open question={question} onReturnToAnswer={onReturn} />);

    await userEvent.click(screen.getByRole('button', { name: /给我第一阶/ }));
    await waitFor(() => expect(screen.getByText(/没生成出来/)).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: '我自己来' }));

    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('after revealing the full solution, “回到自己作答” closes the host drawer', async () => {
    const onReturn = vi.fn();
    render(<HintLadder open question={question} onReturnToAnswer={onReturn} />);

    await userEvent.click(screen.getByRole('button', { name: '直接看完整解' }));
    await userEvent.click(screen.getByRole('button', { name: '确认 · 看完整解' }));
    await userEvent.click(screen.getByRole('button', { name: '回到自己作答' }));

    expect(onReturn).toHaveBeenCalledTimes(1);
  });
});
