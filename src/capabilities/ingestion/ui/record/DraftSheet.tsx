import { Button } from '@/ui-next/public';
import { MaterialTiles } from './MaterialTiles';
import { useRecordClient } from './record-client';
import { dropDraft, recordMaterial, useDraft } from './record-start';

/**
 * A recording that is still being sent: the same sheet a recording lives in, so nothing jumps
 * when the server takes it over. On failure the material is kept for one more try.
 */
export function DraftSheet({ onStarted }: { onStarted: (sessionId: string) => void }) {
  const { createSession } = useRecordClient();
  const draft = useDraft();
  if (!draft) return null;
  const { material, previews, done, failed } = draft;
  const total = material.kind === 'pdf' || material.kind === 'docx' ? 1 : material.files.length;
  const sentence = failed
    ? '没传上去'
    : material.kind === 'pdf'
      ? '正在把 PDF 拆成页…'
      : material.kind === 'docx'
        ? '正在打开 Word 文件…'
        : `正在上传 ${Math.min(done + 1, total)} / ${total}`;

  return (
    <article className="rc-sheet" aria-busy={!failed} aria-label="正在放进来的材料">
      <header className="rc-sheet-head">
        <p className="rc-sheet-meta">刚刚</p>
      </header>
      <p className="rc-status" data-tone={failed ? 'critical' : 'working'} aria-live="polite">
        {sentence}
      </p>
      {!failed && (
        <div className="rc-meter" aria-hidden="true">
          <span style={{ transform: `scaleX(${total > 0 ? Math.max(0.06, done / total) : 0})` }} />
        </div>
      )}
      <MaterialTiles
        files={material.files}
        previews={previews}
        material={material}
        uploaded={failed ? undefined : done}
      />
      {failed && (
        <div className="rc-trouble">
          <p>{failed}</p>
          <div className="rc-actions">
            <Button
              variant="primary"
              onClick={() =>
                void recordMaterial(draft, createSession).then((id) => {
                  if (id) onStarted(id);
                })
              }
            >
              再传一次
            </Button>
            <Button variant="ghost" onClick={dropDraft}>
              不传了
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
