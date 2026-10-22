import { useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { showToast } from '@/ui-next/feedback/toast-store';
import { Button, Segmented } from '@/ui-next/public';
import type { QuestionPatchBody } from '../practice-api';
import type { QuestionFullDetail } from './library-api';
import { DIFFICULTY_WORDS } from './library-copy';
import { useLookups } from './use-library';
import { useSaveQuestion, writeErrorText } from './use-question-writes';

type Difficulty = '1' | '2' | '3' | '4' | '5';
const DIFFICULTIES: Difficulty[] = ['1', '2', '3', '4', '5'];

function sameList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Edit in place of the paper: stem, options, answer, difficulty, knowledge points. */
export function QuestionEditor({
  detail,
  onDone,
}: {
  detail: QuestionFullDetail;
  onDone: () => void;
}) {
  const lookups = useLookups();
  const save = useSaveQuestion(detail.id);
  const [stem, setStem] = useState(detail.prompt_md);
  const [choices, setChoices] = useState((detail.choices_md ?? []).join('\n'));
  const [answer, setAnswer] = useState(detail.reference_md ?? '');
  const [difficulty, setDifficulty] = useState(String(detail.difficulty) as Difficulty);
  const [knowledge, setKnowledge] = useState<string[]>([...detail.knowledge_ids]);
  const [error, setError] = useState<string | null>(null);
  const hasChoices = (detail.choices_md?.length ?? 0) > 0 || detail.kind === 'choice';

  const choiceList = choices
    .split('\n')
    .map((c) => c.trim())
    .filter(Boolean);
  const body: QuestionPatchBody = { version: detail.version };
  if (stem.trim() !== detail.prompt_md.trim()) body.prompt_md = stem.trim();
  if (answer.trim() !== (detail.reference_md ?? '').trim())
    body.reference_md = answer.trim() || null;
  if (hasChoices && !sameList(choiceList, detail.choices_md ?? []))
    body.choices_md = choiceList.length ? choiceList : null;
  if (Number(difficulty) !== detail.difficulty) body.difficulty = Number(difficulty);
  if (!sameList(knowledge, detail.knowledge_ids)) body.knowledge_ids = knowledge;
  const changed = Object.keys(body).length > 1;

  const submit = () => {
    if (!stem.trim()) return setError('题目不能是空的。');
    setError(null);
    save.mutate(body, {
      onSuccess: () => {
        showToast({ message: '已保存' });
        onDone();
      },
      onError: (err) =>
        setError(
          err instanceof ApiError && err.status === 409
            ? '这道题刚刚在别处改过了。先取消，看过最新的内容再改。'
            : writeErrorText(err),
        ),
    });
  };

  const nameOf = (id: string) =>
    lookups.knowledgeName(id) ?? detail.labels.find((l) => l.id === id)?.name ?? '没有名字的知识点';
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
      {hasChoices && (
        <label className="qd-field">
          <span className="qd-field-label">选项（一行一个）</span>
          <textarea
            className="qd-input qd-textarea"
            rows={4}
            value={choices}
            onChange={(e) => setChoices(e.currentTarget.value)}
          />
        </label>
      )}
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
              {k.name}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="qd-error" role="alert">
          {error}
        </p>
      )}
      <div className="qd-notice-actions">
        <Button size="sm" variant="primary" disabled={!changed || save.isPending} onClick={submit}>
          {save.isPending ? '正在保存…' : '保存'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          取消
        </Button>
      </div>
    </section>
  );
}
