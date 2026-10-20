import { useRef, useState } from 'react';
import { Button } from '@/ui-next/public';
import { HandFields } from './HandFields';
import { MaterialTiles } from './MaterialTiles';
import type { UsePolicy } from './record-api';
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
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [answerOnly, setAnswerOnly] = useState(false);
  const [agentOn, setAgentOn] = useState(PAPER_DEFAULT_LANE === 'agent');
  const [over, setOver] = useState(false);
  const [handSaved, setHandSaved] = useState(false);
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
    setHandSaved(false);
    setFiles((cur) => [...cur, ...incoming]);
    setPreviews((cur) => [
      ...cur,
      ...incoming.map((f) => (isImage(f) ? URL.createObjectURL(f) : '')),
    ]);
  };
  const remove = (index: number) => {
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
    const id = await recordMaterial(handed);
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
            setText(e.target.value);
            setHandSaved(false);
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
          prompt={text}
          onSaved={() => {
            setText('');
            setHandSaved(true);
          }}
        />
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
          收进题库了，记在「做错过」里。
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
