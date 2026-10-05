// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigTaskEditor } from './config-task-editor';
import { configFixture } from './config-test-fixture';

afterEach(cleanup);
function setup(save = vi.fn(async () => {})) {
  const data = configFixture();
  const onClose = vi.fn();
  render(
    <ConfigTaskEditor
      task={data.tasks[0]}
      providers={data.providers}
      save={save}
      onClose={onClose}
    />,
  );
  return { save, onClose, user: userEvent.setup() };
}
describe('task editor', () => {
  it('switches native model choices with the provider and only saves after confirmation', async () => {
    const { user, save, onClose } = setup();
    await user.selectOptions(screen.getByLabelText('Provider'), 'opencode-go');
    expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('glm-5.3-flash');
    expect(screen.queryByRole('option', { name: /mimo-v2.5-pro/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '保存模型组合' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: '确认配置变更' }).textContent).toContain(
      'xiaomi / mimo-v2.5-pro → opencode-go / glm-5.3-flash',
    );
    await user.click(screen.getByRole('button', { name: '确认变更' }));
    expect(save).toHaveBeenCalledWith([
      { action: 'set', key: 'task.QuizGenTask.provider', value: 'opencode-go' },
      { action: 'set', key: 'task.QuizGenTask.model', value: 'glm-5.3-flash' },
    ]);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('cancels without writing and disables providers without credentials', async () => {
    const { user, save, onClose } = setup();
    expect(
      (screen.getByRole('option', { name: /anthropic-sub/ }) as HTMLOptionElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: '取消编辑' }));
    expect(save).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('resets only the provider/model group', async () => {
    const { user, save } = setup();
    await user.click(screen.getByRole('button', { name: '恢复默认模型' }));
    await user.click(screen.getByRole('button', { name: '确认变更' }));
    expect(save).toHaveBeenCalledWith([
      { action: 'clear', key: 'task.QuizGenTask.provider' },
      { action: 'clear', key: 'task.QuizGenTask.model' },
    ]);
  });
  it('shows server rejection without closing or reporting success', async () => {
    const { user, onClose } = setup(
      vi.fn(async () => {
        throw new Error('model is not in native pi catalog');
      }),
    );
    await user.click(screen.getByRole('button', { name: '保存模型组合' }));
    await user.click(screen.getByRole('button', { name: '确认变更' }));
    expect(screen.getByRole('alert').textContent).toContain('native pi catalog');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('edits only wired budget fields and persists seconds as milliseconds', async () => {
    const { user, save } = setup();
    expect(screen.queryByRole('spinbutton', { name: '费用上限（美元）' })).toBeNull();
    const timeout = screen.getByRole('spinbutton', { name: '超时（秒）' });
    await user.clear(timeout);
    await user.type(timeout, '95');
    await user.click(screen.getByRole('button', { name: '保存预算' }));
    await user.click(screen.getByRole('button', { name: '确认变更' }));
    expect(save).toHaveBeenCalledWith([
      {
        action: 'set',
        key: 'task.QuizGenTask.budget',
        value: { maxIterations: 6, timeout: 95000, transientRetries: 0 },
      },
    ]);
  });
});
