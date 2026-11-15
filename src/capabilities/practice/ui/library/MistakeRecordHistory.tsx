import { useState } from 'react';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { type MistakeRecord, RECORD_WORDS, causeWords } from './mistake-read';
import type { LibraryLookups } from './use-library';

const recordTime = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function FrozenRecord({ record, lookups }: { record: MistakeRecord; lookups: LibraryLookups }) {
  const [referenceOpen, setReferenceOpen] = useState(false);
  const notation = lookups.notationFor(record.knowledgeIds);
  const timestamp = new Date(record.createdAtSec * 1000);
  const state = RECORD_WORDS[record.standing];
  return (
    <li className="ql-mistake-record">
      <header className="ql-mistake-head">
        <time dateTime={timestamp.toISOString()} className="un-num">
          {recordTime.format(timestamp)}
        </time>
        {state && (
          <span className="ql-state" data-tone="neutral">
            {state}
          </span>
        )}
      </header>
      <section className="ql-mistake-section" aria-label="当时的题目与材料">
        <h3 className="ql-mistake-label">当时的题目与材料</h3>
        {record.promptMd.trim() ? (
          <MathMarkdown notation={notation}>{record.promptMd}</MathMarkdown>
        ) : (
          <p className="ql-note">这条记录没有留下文字题面。</p>
        )}
        {record.promptMaterials.length > 0 ? (
          <ol className="ql-mistake-materials">
            {record.promptMaterials.map((material, index) => {
              const label = material.alt_text || material.caption || `原题材料 ${index + 1}`;
              return (
                <li key={`${material.material_id}:${index}`}>
                  <figure className="ql-mistake-material">
                    {material.availability === 'inline' ? (
                      <MathMarkdown notation={notation}>{material.content_md}</MathMarkdown>
                    ) : material.availability === 'available' ? (
                      <AssetEvidencePreview
                        assetId={material.asset_id}
                        label={label}
                        variant="inline"
                      />
                    ) : (
                      <p className="ql-note">
                        {material.availability === 'missing'
                          ? '这份原题材料没有存下来。'
                          : '这份原题材料暂不可用。'}
                        {material.alt_text && ` ${material.alt_text}`}
                      </p>
                    )}
                    <figcaption className="ql-note">
                      {material.caption ? (
                        <MathMarkdown notation={notation}>{material.caption}</MathMarkdown>
                      ) : (
                        `原题材料 ${index + 1}`
                      )}
                    </figcaption>
                  </figure>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="ql-note">这条记录没有附带冻结材料。</p>
        )}
      </section>
      <section className="ql-mistake-section" aria-label="我当时的作答">
        <h3 className="ql-mistake-label">我当时的作答</h3>
        {record.wrongAnswerMd.trim() ? (
          <MathMarkdown notation={notation}>{record.wrongAnswerMd}</MathMarkdown>
        ) : (
          <p className="ql-note">
            {record.wrongAnswerImages.length ? '当时的作答保存在以下照片中。' : '没有留下作答。'}
          </p>
        )}
        {record.wrongAnswerImages.length > 0 && (
          <ol className="ql-mistake-materials" aria-label="我的原始作答照片">
            {record.wrongAnswerImages.map((assetId, index) => (
              <li key={`${assetId}:${index}`}>
                <figure className="ql-mistake-material">
                  <AssetEvidencePreview
                    assetId={assetId}
                    kind="image"
                    label={`我的原始作答照片 ${index + 1}`}
                    variant="inline"
                  />
                  <figcaption className="ql-note">我的原始作答照片 {index + 1}</figcaption>
                </figure>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="ql-mistake-section" aria-label="当时的原因与备注">
        <h3 className="ql-mistake-label">当时的原因与备注</h3>
        <p>{causeWords(record.cause, lookups.causeLabel)}</p>
        {record.causeDescription && (
          <MathMarkdown notation={notation}>{record.causeDescription}</MathMarkdown>
        )}
        {record.cause?.note && <p className="ql-mistake-note">我的备注：{record.cause.note}</p>}
      </section>
      <details
        className="ql-mistake-reference"
        onToggle={(event) => setReferenceOpen(event.currentTarget.open)}
      >
        <summary className="un-hit">当时封存的参考答案</summary>
        {referenceOpen &&
          (record.referenceMd?.trim() ? (
            <MathMarkdown notation={notation}>{record.referenceMd}</MathMarkdown>
          ) : (
            <p className="ql-note">这条记录没有留下参考答案。</p>
          ))}
      </details>
    </li>
  );
}

export function MistakeRecordHistory({
  records,
  lookups,
  partial,
}: {
  records: readonly MistakeRecord[];
  lookups: LibraryLookups;
  partial: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="ql-mistake-history" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="un-hit">
        查看{partial ? '已加载的 ' : '全部 '}
        {records.length} 条原始记录
      </summary>
      {open && (
        <>
          <p className="ql-note">以下是各次记录封存的内容，题目链接打开的是当前题目。</p>
          <ol className="ql-mistake-records">
            {records.map((record) => (
              <FrozenRecord key={record.id} record={record} lookups={lookups} />
            ))}
          </ol>
        </>
      )}
    </details>
  );
}
