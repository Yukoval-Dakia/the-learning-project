import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ApiAuthError, ApiError } from '@/ui/lib/api';
import { randomId } from '@/ui/lib/random-id';
import { Button } from '@/ui-next/public';
import { HAND_EMPTY, type Hand, HandFields } from './HandFields';
import { MaterialTiles } from './MaterialTiles';
import type { RecordManualMistakeInput, UsePolicy } from './record-api';
import { useRecordClient } from './record-client';
import {
  type Lane,
  PAPER_DEFAULT_LANE,
  agentPossible,
  fileKey,
  readMaterial,
  recordMaterial,
  useDraft,
} from './record-start';

const ACCEPT = 'image/png,image/jpeg,image/webp,application/pdf,.pdf,.docx';

const isImage = (f: File) => f.type.startsWith('image/');

type HandOperation = {
  input: RecordManualMistakeInput;
  revision: number;
};

function isHandRejection(error: unknown): boolean {
  return (
    error instanceof ApiAuthError ||
    (error instanceof ApiError && error.status >= 400 && error.status < 500)
  );
}

/**
 * The single place material goes in: photos, a PDF or a Word file (picked, dropped or pasted),
 * or a question typed out. What kind of material it is decides itself; nothing to choose first.
 */
export function Composer({
  onStarted,
  navigate,
}: {
  onStarted: (sessionId: string) => void;
  navigate: (to: string) => void;
}) {
  const { createSession, startLane, createWrongAnswer } = useRecordClient();
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [answerOnly, setAnswerOnly] = useState(false);
  const [agentOn, setAgentOn] = useState(PAPER_DEFAULT_LANE === 'agent');
  const [over, setOver] = useState(false);
  const [handSaved, setHandSaved] = useState<'current' | 'previous' | null>(null);
  // The typed question's answer and knowledge points live here, so material dropped in mid-typing
  // hides them for a moment instead of throwing them away.
  const [hand, setHand] = useState<Hand>(HAND_EMPTY);
  const handRevision = useRef(0);
  const handPending = useRef(false);
  const handOperation = useRef<HandOperation | null>(null);
  const handSave = useMutation({
    retry: false,
    mutationFn: async (operation: HandOperation) => {
      const result = await createWrongAnswer(operation.input);
      if (
        !result ||
        typeof result.question_id !== 'string' ||
        result.question_id.length === 0 ||
        typeof result.mistake_id !== 'string' ||
        result.mistake_id.length === 0
      ) {
        throw new Error('Manual save acknowledgement missing');
      }
      return result;
    },
    onSuccess: (_result, operation) => {
      handOperation.current = null;
      const sameRevision = handRevision.current === operation.revision;
      if (sameRevision) {
        handRevision.current += 1;
        setText('');
        setHand(HAND_EMPTY);
      }
      setHandSaved(sameRevision ? 'current' : 'previous');
    },
    onError: (error) => {
      if (isHandRejection(error)) handOperation.current = null;
    },
    onSettled: () => {
      handPending.current = false;
    },
  });
  const handUnknown = handSave.isError && !isHandRejection(handSave.error);
  const submitHand = (operation: HandOperation) => {
    if (handPending.current) return;
    handPending.current = true;
    handOperation.current = operation;
    setHandSaved(null);
    handSave.mutate(operation);
  };
  const saveHand = () => {
    if (
      handPending.current ||
      handOperation.current ||
      !text.trim() ||
      !hand.answer.trim() ||
      hand.knowledge.length === 0
    ) {
      return;
    }
    submitHand(
      Object.freeze({
        revision: handRevision.current,
        input: Object.freeze({
          prompt: text.trim(),
          answer: hand.answer.trim(),
          knowledgeIds: Object.freeze([...hand.knowledge]),
          idempotencyKey: randomId(),
        }),
      }),
    );
  };
  const pickRef = useRef<HTMLInputElement>(null);
  const draft = useDraft();

  const material = files.length > 0 ? readMaterial(files) : null;
  const policy: UsePolicy = answerOnly ? 'answer_only' : 'allow';
  const agentOffer = material !== null && agentPossible(material, 'allow');
  const lane: Lane = material && agentPossible(material, policy) && agentOn ? 'agent' : 'extract';

  const add = (picked: File[]) => {
    const have = new Set(files.map(fileKey));
    const incoming = picked.filter((f) => !have.has(fileKey(f)));
    if (incoming.length === 0) return;
    handRevision.current += 1;
    setHandSaved(null);
    setFiles((cur) => [...cur, ...incoming]);
    setPreviews((cur) => [
      ...cur,
      ...incoming.map((f) => (isImage(f) ? URL.createObjectURL(f) : '')),
    ]);
  };
  const remove = (index: number) => {
    handRevision.current += 1;
    if (previews[index]) URL.revokeObjectURL(previews[index]);
    setFiles((cur) => cur.filter((_, i) => i !== index));
    setPreviews((cur) => cur.filter((_, i) => i !== index));
  };

  const start = async () => {
    if (!material || material.kind === 'invalid') return;
    // The draft takes the previews over; it releases them when the upload settles.
    const handed = { material, policy, lane, previews };
    setFiles([]);
    setPreviews([]);
    const id = await recordMaterial(handed, createSession, startLane);
    if (id) onStarted(id);
  };

  const typing = files.length === 0 && text.trim().length > 0;

  return (
    <section
      className="rc-composer"
      data-over={over}
      aria-label="放进来"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        add(Array.from(e.dataTransfer.files));
      }}
    >
      {files.length === 0 ? (
        <textarea
          className="rc-area rc-composer-text"
          rows={typing ? 4 : 2}
          value={text}
          aria-label="直接打一道题"
          placeholder="直接打一道题，或者把照片、PDF、Word 拖到这里"
          onChange={(e) => {
            handRevision.current += 1;
            setText(e.target.value);
            setHandSaved(null);
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length > 0) {
              e.preventDefault();
              add(pasted);
            }
          }}
        />
      ) : (
        <MaterialTiles
          files={files}
          previews={previews}
          material={material}
          onRemove={remove}
          onAddMore={() => pickRef.current?.click()}
        />
      )}

      <input
        ref={pickRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="un-sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          add(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      {typing && (
        <HandFields
          hand={hand}
          onHand={(next) => {
            handRevision.current += 1;
            setHand(next);
            setHandSaved(null);
          }}
          pending={handSave.isPending}
          unresolved={handUnknown}
          onSave={saveHand}
        />
      )}
      {files.length > 0 && text.trim() !== '' && (
        <p className="rc-quiet">打好的那道题还在，把这些文件移走就能接着写。</p>
      )}

      {handSave.isPending && (
        <p className="rc-quiet" role="status">
          正在确认保存结果，当前输入仍可编辑。
        </p>
      )}
      {handSave.isError && (
        <div className="rc-trouble" data-tone={handUnknown ? 'neutral' : undefined} role="status">
          <p className="rc-trouble-title">{handUnknown ? '保存结果未确认' : '没有收到保存成功'}</p>
          <p>题面、答案和知识点仍保留。</p>
          {handUnknown && <p>继续原保存只使用上次提交的内容；先确认原结果，再保存当前修改。</p>}
          <div className="rc-actions">
            {handUnknown && (
              <Button
                variant="secondary"
                onClick={() => {
                  const operation = handOperation.current;
                  if (operation) submitHand(operation);
                }}
              >
                继续原保存
              </Button>
            )}
            <button
              type="button"
              className="rc-link"
              onClick={() =>
                window.open('/questions?view=mistakes', '_blank', 'noopener,noreferrer')
              }
            >
              新窗口核对「做错过」
            </button>
          </div>
        </div>
      )}

      {!typing && (
        <div className="rc-bar">
          <div className="rc-options">
            {files.length === 0 ? (
              <Button variant="secondary" onClick={() => pickRef.current?.click()}>
                拍照或选文件
              </Button>
            ) : (
              <>
                <label className="rc-switch">
                  <input
                    type="checkbox"
                    checked={answerOnly}
                    onChange={(e) => setAnswerOnly(e.target.checked)}
                  />
                  <span>只用来收这些题，不拿去总结我的学习情况</span>
                </label>
                {agentOffer && (
                  <label className="rc-switch" data-off={answerOnly}>
                    <input
                      type="checkbox"
                      checked={agentOn && !answerOnly}
                      disabled={answerOnly}
                      onChange={(e) => setAgentOn(e.target.checked)}
                    />
                    <span>
                      让录入助手整理
                      <span className="rc-quiet">
                        {answerOnly
                          ? ' · 只用来收题的材料不交给它'
                          : ' · 它会自己解题、核对答案，拿不准会问你；每周有启动额度'}
                      </span>
                    </span>
                  </label>
                )}
              </>
            )}
          </div>
          {files.length > 0 && (
            <Button
              variant="primary"
              disabled={!material || material.kind === 'invalid' || draft !== null}
              onClick={() => void start()}
            >
              开始收题
            </Button>
          )}
        </div>
      )}

      {handSaved && (
        <p className="rc-saved" role="status">
          {handSaved === 'previous'
            ? '上次提交的题已收进题库，本页后来的修改仍保留。'
            : '收进题库了，记在「做错过」里。'}
          <button
            type="button"
            className="rc-link"
            onClick={() => navigate('/questions?view=mistakes')}
          >
            去看看
          </button>
        </p>
      )}
    </section>
  );
}
