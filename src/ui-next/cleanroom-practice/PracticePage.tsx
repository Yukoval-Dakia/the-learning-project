import { useId } from 'react';
import type {
  Action,
  AnswerField,
  Appeal,
  Confidence,
  Content,
  Material,
  Notice,
  PracticeContentProps,
  PracticeIntents,
  PracticeRenderers,
  Result,
  SelfRating,
  Verdict,
} from './contracts';
import './practice.css';

const verdicts: Record<Verdict, string> = {
  correct: '✓ 正确',
  partial: '◐ 部分正确',
  incorrect: '× 需要订正',
  unanswered: '— 未作答',
  review: '◇ 待复核',
  unknown: '? 结果未知',
};
const recordingLabels = {
  idle: '',
  saving: '正在保存作答',
  saved: '作答已保存',
  unknown: '作答是否保存尚不确定',
  failed: '作答保存失败',
};
const gradingLabels = {
  idle: '',
  pending: '等待判分',
  grading: '正在判分',
  unknown: '判分结果尚不确定',
  failed: '判分失败',
  settled: '判分完成',
  manual: '这道题需要自行评级',
};
const draftLabels = {
  restoring: '恢复草稿中',
  empty: '暂无草稿',
  saving: '正在保存',
  saved: '已保存',
  offline: '离线，尚未同步',
  failed: '保存失败',
  conflict: '草稿版本冲突',
};

function renderContent(renderers: PracticeRenderers, content: Content) {
  const scrollable = content.kind === 'math' || content.kind === 'table' || content.kind === 'code';
  return scrollable ? (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll wide math, code and tables without focusing their contents.
    <section className="un-cr-content" aria-label={content.label} tabIndex={0}>
      {renderers.content(content)}
    </section>
  ) : (
    <div className="un-cr-content">{renderers.content(content)}</div>
  );
}

function IntentButton({
  action,
  intents,
  primary = false,
  blocked = false,
}: {
  action: Action;
  intents: PracticeIntents;
  primary?: boolean;
  blocked?: boolean;
}) {
  const id = useId();
  const unavailable = action.availability.kind !== 'enabled';
  return (
    <div className="un-cr-action">
      <button
        type="button"
        className={primary ? 'un-cr-button un-cr-primary' : 'un-cr-button'}
        disabled={unavailable || blocked}
        aria-busy={action.availability.kind === 'busy'}
        aria-describedby={unavailable ? id : undefined}
        onClick={() => {
          if (!unavailable && !blocked) intents.action(action.id);
        }}
      >
        <span>{action.label}</span>
      </button>
      {action.availability.kind !== 'enabled' && (
        <small id={id}>{action.availability.reason}</small>
      )}
    </div>
  );
}
function Actions({ actions, intents }: { actions?: readonly Action[]; intents: PracticeIntents }) {
  return actions?.length ? (
    <div className="un-cr-actions">
      {actions.map((a) => (
        <IntentButton key={a.id} action={a} intents={intents} />
      ))}
    </div>
  ) : null;
}
function NoticeBlock({ notice, intents }: { notice: Notice; intents: PracticeIntents }) {
  return (
    <div className="un-cr-notice">
      <strong>{notice.title}</strong>
      {notice.detail && <p>{notice.detail}</p>}
      <Actions actions={notice.actions} intents={intents} />
    </div>
  );
}
function Answer({
  field,
  intents,
  renderers,
}: {
  field: AnswerField;
  intents: PracticeIntents;
  renderers: PracticeRenderers;
}) {
  const id = useId();
  const locked = field.mode !== 'editable';
  const described = `${id}-help`;
  return (
    <fieldset className="un-cr-field" aria-busy={field.mode === 'busy'}>
      <legend>{field.label}</legend>
      <div id={described} className="un-cr-help">
        {field.hint && <p>{field.hint}</p>}
        {locked && (
          <p>
            {field.mode === 'readonly' ? '只读' : '暂不可编辑'}
            {field.reason ? `：${field.reason}` : ''}
          </p>
        )}
        {field.error && <p className="un-cr-error">! {field.error}</p>}
      </div>
      {field.kind === 'withheld' ? (
        <p>暂不能使用此作答方式：{field.reason}</p>
      ) : field.kind === 'specialized' ? (
        field.safety.kind === 'withheld' ? (
          <p>暂不能使用此作答方式：{field.safety.reason}</p>
        ) : (
          renderers.answer({
            id: field.controlId,
            accessibleName: field.label,
            boundaryId: field.safety.boundaryId,
            mode: field.mode,
            reason: field.reason,
            describedBy: described,
            invalid: !!field.error,
            onIntent: (payload) => {
              if (!locked) intents.specializedAnswer(field.id, payload);
            },
          })
        )
      ) : field.kind === 'single' || field.kind === 'multiple' ? (
        <div className="un-cr-options">
          {field.options.map((option) => (
            <label
              key={option.id}
              className="un-cr-option"
              data-selected={field.selected.includes(option.id)}
            >
              <input
                type={field.kind === 'single' ? 'radio' : 'checkbox'}
                name={id}
                checked={field.selected.includes(option.id)}
                disabled={locked}
                aria-invalid={!!field.error}
                aria-describedby={described}
                onChange={(event) =>
                  intents.answer(
                    field.id,
                    field.kind === 'single'
                      ? [option.id]
                      : event.target.checked
                        ? [...field.selected, option.id]
                        : field.selected.filter((x) => x !== option.id),
                  )
                }
              />
              <span className="un-cr-option-key">{option.key}</span>
              <div className="un-cr-option-body">{renderContent(renderers, option.content)}</div>
            </label>
          ))}
        </div>
      ) : field.kind === 'attachments' ? (
        <>
          <label className="un-cr-upload">
            添加附件
            <input
              type="file"
              accept={field.accept}
              multiple={field.multiple}
              disabled={locked}
              aria-describedby={described}
              aria-invalid={!!field.error}
              onChange={(event) => {
                if (event.target.files) intents.attach(field.id, Array.from(event.target.files));
                event.target.value = '';
              }}
            />
          </label>
          <ul className="un-cr-list">
            {field.items.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>
                <p>
                  {item.state.kind === 'complete'
                    ? '✓ 上传完成'
                    : item.state.kind === 'failed'
                      ? `! 上传失败：${item.state.detail}`
                      : '正在上传'}
                </p>
                {item.state.kind === 'uploading' &&
                  (item.state.progress === undefined ? (
                    <p>进度未知</p>
                  ) : (
                    <progress
                      aria-label={`${item.name}上传进度`}
                      max={100}
                      value={item.state.progress}
                    />
                  ))}
                <Actions actions={item.actions} intents={intents} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <label className="un-cr-input-label">
          <span className="un-cr-sr">{field.label}</span>
          <textarea
            value={'value' in field ? field.value : ''}
            rows={field.kind === 'text' ? 5 : 2}
            inputMode={field.kind === 'number' ? 'decimal' : 'text'}
            readOnly={field.mode === 'readonly'}
            disabled={field.mode === 'disabled' || field.mode === 'busy'}
            aria-describedby={described}
            aria-invalid={!!field.error}
            onChange={(event) => intents.answer(field.id, event.target.value)}
          />
        </label>
      )}
    </fieldset>
  );
}
function Results({ result, renderers }: { result: Result; renderers: PracticeRenderers }) {
  const id = useId();
  return (
    <section className="un-cr-results" aria-labelledby={id}>
      <h2 id={id}>{verdicts[result.verdict]}</h2>
      <p>{result.summary}</p>
      <details>
        <summary>解释与参考</summary>
        {result.reference.kind === 'ready' ? (
          renderContent(renderers, result.reference.content)
        ) : (
          <p>{result.reference.reason}</p>
        )}
      </details>
      {result.evidence.length > 0 && (
        <details>
          <summary>判分依据</summary>
          {result.evidence.map((c) => (
            <div key={c.id}>{renderContent(renderers, c)}</div>
          ))}
        </details>
      )}
      {result.uncertainty && <p className="un-cr-notice">不确定性：{result.uncertainty}</p>}
    </section>
  );
}
function Rating({ rating, intents }: { rating: SelfRating; intents: PracticeIntents }) {
  const id = useId();
  return (
    <fieldset className="un-cr-field">
      <legend>{rating.label}</legend>
      <p id={`${id}-reason`}>{rating.reason}</p>
      <div className="un-cr-options">
        {rating.options.map((option) => (
          <label
            className="un-cr-option"
            key={option.id}
            data-selected={rating.value === option.id}
          >
            <input
              type="radio"
              name={id}
              checked={rating.value === option.id}
              disabled={rating.disabled}
              aria-describedby={`${id}-reason`}
              onChange={() => intents.rating(option.id)}
            />
            {option.label}
          </label>
        ))}
      </div>
      <Actions actions={rating.actions} intents={intents} />
    </fieldset>
  );
}
function ConfidenceStep({
  confidence,
  intents,
}: {
  confidence: Confidence;
  intents: PracticeIntents;
}) {
  const id = useId();
  const values = [1, 2, 3, 4, 5] as const;
  return (
    <section className="un-cr-confidence">
      <h2>你有几分把握？</h2>
      <p>1 表示很没把握，5 表示很有把握。也可以跳过。</p>
      <fieldset className="un-cr-field">
        <legend>选择把握程度</legend>
        <div className="un-cr-confidence-options">
          {values.map((value) => (
            <label className="un-cr-option" key={value} data-selected={confidence.value === value}>
              <input
                type="radio"
                name={id}
                checked={confidence.value === value}
                disabled={confidence.availability.kind !== 'enabled'}
                aria-describedby={`${id}-reason`}
                onChange={() => intents.confidence(value)}
              />
              {value}
            </label>
          ))}
        </div>
        <p id={`${id}-reason`}>
          {confidence.availability.kind !== 'enabled' ? confidence.availability.reason : ''}
        </p>
      </fieldset>
      <div className="un-cr-actions">
        {confidence.continue && (
          <IntentButton action={confidence.continue} intents={intents} primary />
        )}
        <IntentButton action={confidence.skip} intents={intents} />
      </div>
    </section>
  );
}
function AppealSection({
  appeal,
  intents,
  renderers,
}: {
  appeal: Appeal;
  intents: PracticeIntents;
  renderers: PracticeRenderers;
}) {
  return (
    <section>
      <h2>
        申诉 ·{' '}
        {
          {
            available: '可提出',
            editing: '填写中',
            sending: '正在提交',
            waiting: '等待处理',
            failed: '提交失败',
            resolved: '已有处理结果',
          }[appeal.kind]
        }
      </h2>
      <NoticeBlock notice={appeal.notice} intents={intents} />
      {appeal.field && <Answer field={appeal.field} intents={intents} renderers={renderers} />}
    </section>
  );
}
function Materials({
  items,
  intents,
  renderers,
}: {
  items: readonly Material[];
  intents: PracticeIntents;
  renderers: PracticeRenderers;
}) {
  return (
    <>
      {items.map((material) => (
        <section className="un-cr-material" key={material.id}>
          <h3>{material.title}</h3>
          {material.state.kind === 'ready' ? (
            renderContent(renderers, material.state.content)
          ) : (
            <NoticeBlock notice={material.state.notice} intents={intents} />
          )}
        </section>
      ))}
    </>
  );
}

/** Pure question surface. Its owner supplies the original operation refs and data. */
export function PracticeContent({
  view,
  renderers,
  intents,
  lifecycle,
  surfaces,
}: PracticeContentProps) {
  const id = useId();
  const question =
    view.page.kind === 'ready' || view.page.kind === 'partial' ? view.page.question : null;
  return (
    <section
      ref={lifecycle?.contentRef}
      data-view-identity={view.identity}
      data-question-identity={question?.id}
      id="practice-content"
      tabIndex={-1}
      className="un-cr-main"
    >
      {view.feedback && <NoticeBlock notice={view.feedback} intents={intents} />}
      {question ? (
        <div className="un-cr-question-body" ref={lifecycle?.answeringRootRef}>
          <header className="un-cr-context">
            <p>
              {question.subject} · {question.progressLabel}
            </p>
            <h1 ref={lifecycle?.titleRef} tabIndex={-1}>
              {question.title}
            </h1>
            <ul className="un-cr-meta">
              {Object.entries({
                attempt: question.attemptLabel,
                time: question.estimatedTime,
                source: question.source,
                reason: question.reason,
              })
                .filter(([, text]) => Boolean(text))
                .map(([key, text]) => (
                  <li key={key}>{text}</li>
                ))}
            </ul>
            <Actions actions={question.supportActions} intents={intents} />
          </header>
          {view.page.kind === 'partial' && view.page.missing && (
            <NoticeBlock notice={view.page.missing} intents={intents} />
          )}
          <div ref={lifecycle?.quotableRef}>
            {surfaces?.questionBody !== undefined ? (
              surfaces.questionBody
            ) : (
              <>
                <section className="un-cr-reading" aria-label="题干">
                  {renderContent(renderers, question.stem)}
                </section>
                <Materials items={question.materials} intents={intents} renderers={renderers} />
                {question.parts.map((part) => {
                  const feedback =
                    question.revelation.kind === 'revealed'
                      ? question.revelation.result?.parts.find((item) => item.id === part.id)
                      : undefined;
                  return (
                    <section
                      className="un-cr-part"
                      key={part.id}
                      aria-labelledby={`${id}-part-${encodeURIComponent(part.id)}`}
                    >
                      <h2 id={`${id}-part-${encodeURIComponent(part.id)}`}>{part.label}</h2>
                      {renderContent(renderers, part.stem)}
                      <Materials items={part.materials} intents={intents} renderers={renderers} />
                      <div className="un-cr-answer">
                        {part.fields.map((field) => (
                          <Answer
                            key={field.id}
                            field={field}
                            intents={intents}
                            renderers={renderers}
                          />
                        ))}
                      </div>
                      {feedback && (
                        <section>
                          <h3>{verdicts[feedback.verdict]}</h3>
                          {feedback.feedback && renderContent(renderers, feedback.feedback)}
                        </section>
                      )}
                    </section>
                  );
                })}
                {(question.fields.length > 0 ||
                  question.thought ||
                  question.supportActions.length > 0) && (
                  <section className="un-cr-answer" aria-label="你的作答">
                    <h2>你的作答</h2>
                    {question.fields.map((field) => (
                      <Answer
                        key={field.id}
                        field={field}
                        intents={intents}
                        renderers={renderers}
                      />
                    ))}
                    {question.thought && (
                      <details>
                        <summary>补充思路（可选）</summary>
                        <Answer field={question.thought} intents={intents} renderers={renderers} />
                      </details>
                    )}
                  </section>
                )}
              </>
            )}
            {surfaces?.selectionActions}
          </div>
          <section
            className="un-cr-draft"
            data-quiet={['empty', 'saving', 'saved'].includes(question.draft.kind)}
          >
            <p className="un-cr-draft-label">
              {question.draft.kind !== 'empty' && draftLabels[question.draft.kind]}
            </p>
            {question.draft.kind !== 'empty' && (
              <NoticeBlock notice={question.draft.notice} intents={intents} />
            )}
            {question.draft.kind === 'conflict' &&
              surfaces?.conflict !== undefined &&
              surfaces.conflict}
            {question.draft.kind === 'conflict' && surfaces?.conflict === undefined && (
              <div className="un-cr-versions">
                <section>
                  <h3>本地版本</h3>
                  {renderContent(renderers, question.draft.local)}
                </section>
                <section>
                  <h3>远端版本</h3>
                  {renderContent(renderers, question.draft.remote)}
                </section>
              </div>
            )}
          </section>
          <section className="un-cr-submission" aria-label="提交与判分" ref={lifecycle?.resultRef}>
            {question.submission.recording.kind !== 'idle' && (
              <p>{recordingLabels[question.submission.recording.kind]}</p>
            )}
            {question.submission.recording.notice && (
              <NoticeBlock notice={question.submission.recording.notice} intents={intents} />
            )}
            {question.submission.grading.kind !== 'idle' && (
              <p>{gradingLabels[question.submission.grading.kind]}</p>
            )}
            {question.submission.grading.notice && (
              <NoticeBlock notice={question.submission.grading.notice} intents={intents} />
            )}
            {question.submission.continuation && (
              <NoticeBlock notice={question.submission.continuation.notice} intents={intents} />
            )}
            {question.revelation.kind === 'concealed' ? (
              <>
                {question.revelation.reason && <p>{question.revelation.reason}</p>}
                {question.revelation.confidence && (
                  <ConfidenceStep confidence={question.revelation.confidence} intents={intents} />
                )}
              </>
            ) : (
              <div>
                {question.revelation.confidenceRecord && (
                  <p>{question.revelation.confidenceRecord}</p>
                )}
                {question.revelation.result && (
                  <Results result={question.revelation.result} renderers={renderers} />
                )}
                {question.revelation.selfRating && (
                  <Rating rating={question.revelation.selfRating} intents={intents} />
                )}
                {question.revelation.appeal && (
                  <AppealSection
                    appeal={question.revelation.appeal}
                    intents={intents}
                    renderers={renderers}
                  />
                )}
              </div>
            )}
            <div className="un-cr-actions" ref={lifecycle?.submitActionsRef}>
              {question.submission.primary &&
                !(question.revelation.kind === 'concealed' && question.revelation.confidence) && (
                  <IntentButton
                    action={question.submission.primary}
                    intents={intents}
                    primary
                    blocked={
                      question.submission.recording.kind === 'saving' ||
                      question.submission.continuation?.kind === 'advancing'
                    }
                  />
                )}
              <Actions actions={question.submission.secondary} intents={intents} />
            </div>
          </section>
          {surfaces?.history}
        </div>
      ) : (
        <section className="un-cr-page-state" ref={lifecycle?.issuancePlaceholderRef}>
          <h1 ref={lifecycle?.titleRef} tabIndex={-1}>
            做题
          </h1>
          {view.page.kind !== 'ready' && view.page.kind !== 'partial' && (
            <>
              <p>
                {
                  {
                    loading: '正在读取题目',
                    recovering: '正在恢复',
                    empty: '暂无可做内容',
                    forbidden: '无法访问',
                    failed: '读取失败',
                  }[view.page.kind]
                }
              </p>
              <NoticeBlock
                notice={'notice' in view.page ? view.page.notice : { title: '' }}
                intents={intents}
              />
            </>
          )}
        </section>
      )}
      {surfaces?.overlays}
    </section>
  );
}
