import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { showToast } from '@/ui-next/feedback/toast-store';
import { Button, Segmented } from '@/ui-next/public';
import type { QuestionPatchBody } from '../practice-api';
import type { QuestionFullDetail } from './library-api';
import { DIFFICULTY_WORDS } from './library-copy';
import { ChoiceInputs } from './QuestionChoiceInputs';
import { QuestionFigures } from './QuestionFigures';
import { useLookups } from './use-library';
import { questionKey, useSaveQuestion, writeErrorText } from './use-question-writes';

type Difficulty = '1' | '2' | '3' | '4' | '5';
const DIFFICULTIES: Difficulty[] = ['1', '2', '3', '4', '5'];

function sameList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Edit in place of the paper. The form starts from a snapshot of the question taken when editing
 * began; 「载入最新内容」 after a clash starts a fresh form from the question as it is now.
 */
export function QuestionEditor({
  detail,
  onDone,
}: {
  detail: QuestionFullDetail;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [epoch, setEpoch] = useState(0);
  const [reloading, setReloading] = useState(false);
  const reload = async () => {
    setReloading(true);
    await queryClient.refetchQueries({ queryKey: questionKey(detail.id) }).catch(() => undefined);
    setReloading(false);
    setEpoch((n) => n + 1);
  };
  return (
    <EditorForm
      key={epoch}
      detail={detail}
      onDone={onDone}
      onReload={() => void reload()}
      reloading={reloading}
    />
  );
}

function EditorForm({
  detail,
  onDone,
  onReload,
  reloading,
}: {
  detail: QuestionFullDetail;
  onDone: () => void;
  onReload: () => void;
  reloading: boolean;
}) {
  // Diff and version always come from this snapshot, never from a newer refetch.
  const [base] = useState(() => detail);
  const lookups = useLookups();
  const save = useSaveQuestion(base.id);
  const baseChoices = base.choices_md ?? [];
  const [stem, setStem] = useState(base.prompt_md);
  const [choices, setChoices] = useState<string[]>([...baseChoices]);
  const [answer, setAnswer] = useState(base.reference_md ?? '');
  const [difficulty, setDifficulty] = useState(String(base.difficulty) as Difficulty);
  const [knowledge, setKnowledge] = useState<string[]>([...base.knowledge_ids]);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const hasChoices = baseChoices.length > 0 || base.kind === 'choice';

  const body: QuestionPatchBody = { version: base.version };
  if (stem.trim() !== base.prompt_md.trim()) body.prompt_md = stem.trim();
  if (answer.trim() !== (base.reference_md ?? '').trim()) body.reference_md = answer.trim() || null;
  // Options go out only when one was actually edited, added or removed; stored text is never
  // re-split or re-joined.
  if (hasChoices && !sameList(choices, baseChoices))
    body.choices_md = choices.length ? choices.map((c) => c.trim()) : null;
  if (Number(difficulty) !== base.difficulty) body.difficulty = Number(difficulty);
  if (!sameList(knowledge, base.knowledge_ids)) body.knowledge_ids = knowledge;
  const changed = Object.keys(body).length > 1;

  const submit = () => {
    if (!stem.trim()) return setError('题目不能是空的。');
    if (body.choices_md?.some((c) => c === ''))
      return setError('有选项是空的。不要的选项请点「去掉」。');
    setError(null);
    save.mutate(body, {
      onSuccess: () => {
        showToast({ message: '已保存' });
        onDone();
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'conflict') {
          setStale(true);
          setError(null);
        } else setError(writeErrorText(err));
      },
    });
  };

  const nameOf = (id: string) =>
    lookups.knowledgeName(id) ?? base.labels.find((l) => l.id === id)?.name ?? '没有名字的知识点';
  const addable = lookups.knowledgeOptions.filter((k) => !knowledge.includes(k.id));

  return (
    <section className="qd-paper qd-editor" aria-labelledby="qd-edit-h">
      <h2 id="qd-edit-h" className="qd-label">
        修改这道题
      </h2>
      <label className="qd-field">
        <span className="qd-field-label">题目</span>
        <textarea
          className="qd-input qd-textarea"
          rows={6}
          value={stem}
          onChange={(e) => setStem(e.currentTarget.value)}
        />
      </label>
      <QuestionFigures detail={base} />
      {hasChoices && <ChoiceInputs choices={choices} onChange={setChoices} />}
      <label className="qd-field">
        <span className="qd-field-label">参考答案</span>
        <textarea
          className="qd-input qd-textarea"
          rows={3}
          value={answer}
          onChange={(e) => setAnswer(e.currentTarget.value)}
        />
      </label>
      <div className="qd-field">
        <span className="qd-field-label">难度</span>
        <Segmented
          label="难度"
          value={difficulty}
          onChange={setDifficulty}
          options={DIFFICULTIES.map((d) => ({ value: d, label: DIFFICULTY_WORDS[Number(d)] }))}
        />
      </div>
      <div className="qd-field">
        <span className="qd-field-label">练的知识点</span>
        <ul className="qd-kn-list">
          {knowledge.map((id) => (
            <li key={id} className="qd-kn">
              {nameOf(id)}
              <button
                type="button"
                className="ql-text-btn un-hit"
                aria-label={`去掉「${nameOf(id)}」`}
                onClick={() => setKnowledge((list) => list.filter((k) => k !== id))}
              >
                去掉
              </button>
            </li>
          ))}
        </ul>
        <select
          className="qd-input"
          value=""
          aria-label="加一个知识点"
          onChange={(e) => {
            const id = e.currentTarget.value;
            if (id) setKnowledge((list) => [...list, id]);
          }}
        >
          <option value="">加一个知识点…</option>
          {addable.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="qd-error" role="alert">
          {error}
        </p>
      )}
      {stale && (
        <div className="qd-stale" role="alert">
          <p className="qd-error">
            这道题刚刚在别处改过了，你的修改还没保存。载入最新内容会丢掉这里的修改；想留着的话，先把要改的地方记下来。
          </p>
          <Button size="sm" variant="secondary" disabled={reloading} onClick={onReload}>
            {reloading ? '正在载入…' : '载入最新内容'}
          </Button>
        </div>
      )}
      <div className="qd-notice-actions">
        <Button
          size="sm"
          variant="primary"
          disabled={!changed || stale || save.isPending}
          onClick={submit}
        >
          {save.isPending ? '正在保存…' : '保存'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          取消
        </Button>
      </div>
    </section>
  );
}
