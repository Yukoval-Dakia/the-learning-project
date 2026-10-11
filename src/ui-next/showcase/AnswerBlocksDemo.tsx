// Showcase samples for the tap-answer blocks (YUK-1479). Local sample items only: no data fetching,
// no submission, no key. "提交" here only flips the block to its read-only state.
import { type ReactNode, useState } from 'react';
import {
  EMPTY_MATCHING,
  EMPTY_SENTENCE_BREAKS,
  MatchingBlock,
  type MatchingCardinality,
  type MatchingItem,
  type MatchingResponse,
  SentenceBreaksBlock,
  type SentenceBreaksResponse,
} from '../answer';
import { Button } from '../primitives';

const SAMPLE_PASSAGE =
  '古之学者必有师师者所以传道受业解惑也人非生而知之者孰能无惑惑而不从师其为惑也终不解矣生乎吾前其闻道也固先乎吾吾从而师之';

const TERMS_LEFT: MatchingItem[] = [
  { id: 'term-photosynthesis', text: 'photosynthesis' },
  { id: 'term-evaporation', text: 'evaporation' },
  { id: 'term-gravity', text: 'gravity' },
  { id: 'term-erosion', text: 'erosion' },
];
const TERMS_RIGHT: MatchingItem[] = [
  { id: 'zh-erosion', text: '侵蚀' },
  { id: 'zh-photosynthesis', text: '光合作用' },
  { id: 'zh-condensation', text: '凝结' },
  { id: 'zh-gravity', text: '引力' },
  { id: 'zh-evaporation', text: '蒸发' },
];

const WORDS_LEFT: MatchingItem[] = [
  { id: 'w-quickly', text: 'quickly' },
  { id: 'w-happiness', text: 'happiness' },
  { id: 'w-beautiful', text: 'beautiful' },
  { id: 'w-carefully', text: 'carefully' },
];
const POS_RIGHT: MatchingItem[] = [
  { id: 'pos-noun', text: '名词' },
  { id: 'pos-verb', text: '动词' },
  { id: 'pos-adj', text: '形容词' },
  { id: 'pos-adv', text: '副词' },
];

function SampleFrame({
  title,
  response,
  submitted,
  onSubmitted,
  children,
}: {
  title: string;
  response: MatchingResponse | SentenceBreaksResponse;
  submitted: boolean;
  onSubmitted: (next: boolean) => void;
  children: ReactNode;
}) {
  const [showData, setShowData] = useState(false);
  return (
    <article className="un-ab-sample">
      <p className="un-ab-sample-h">
        <span className="un-ab-tag">示例</span>
        {title}
      </p>
      {children}
      <div className="un-ab-sample-actions">
        <Button
          size="sm"
          variant={submitted ? 'ghost' : 'secondary'}
          onClick={() => onSubmitted(!submitted)}
        >
          {submitted ? '继续修改（示例）' : '提交（示例，不会发出）'}
        </Button>
        <Button
          size="sm"
          variant="quiet"
          aria-expanded={showData}
          onClick={() => setShowData((s) => !s)}
        >
          {showData ? '收起作答数据' : '看作答数据'}
        </Button>
      </div>
      {showData ? (
        <pre className="un-ab-json" data-testid="answer-json">
          {JSON.stringify(response)}
        </pre>
      ) : null}
    </article>
  );
}

function MatchingSample({
  title,
  instruction,
  left,
  right,
  cardinality,
  distractors,
  leftHeading,
  rightHeading,
}: {
  title: string;
  instruction: string;
  left: MatchingItem[];
  right: MatchingItem[];
  cardinality: MatchingCardinality;
  distractors?: boolean;
  leftHeading: string;
  rightHeading: string;
}) {
  const [value, setValue] = useState<MatchingResponse>(EMPTY_MATCHING);
  const [submitted, setSubmitted] = useState(false);
  return (
    <SampleFrame title={title} response={value} submitted={submitted} onSubmitted={setSubmitted}>
      <MatchingBlock
        label={title}
        instruction={instruction}
        left={left}
        right={right}
        cardinality={cardinality}
        distractors={distractors}
        leftHeading={leftHeading}
        rightHeading={rightHeading}
        value={value}
        onChange={setValue}
        submitted={submitted}
      />
    </SampleFrame>
  );
}

function SentenceBreaksSample() {
  const [value, setValue] = useState<SentenceBreaksResponse>(EMPTY_SENTENCE_BREAKS);
  const [submitted, setSubmitted] = useState(false);
  return (
    <SampleFrame
      title="断句 · 《师说》节选"
      response={value}
      submitted={submitted}
      onSubmitted={setSubmitted}
    >
      <SentenceBreaksBlock
        label="断句 · 《师说》节选"
        instruction="给下面这段文字断句。每对一处1分、超3处0分。"
        text={SAMPLE_PASSAGE}
        value={value}
        onChange={setValue}
        submitted={submitted}
      />
    </SampleFrame>
  );
}

/** The tap-answer samples, one per block and cardinality. */
export function AnswerBlocksDemo() {
  return (
    <div className="un-ab-demo">
      <p className="un-ab-note">
        以下都是本地示例题，只演示作答方式：不连后端、不判对错、不含答案。
      </p>
      <SentenceBreaksSample />
      <MatchingSample
        title="配对 · 一对一，右列有一项多余"
        instruction="把英文术语和中文意思配对。"
        left={TERMS_LEFT}
        right={TERMS_RIGHT}
        cardinality="one_to_one"
        distractors
        leftHeading="英文"
        rightHeading="中文"
      />
      <MatchingSample
        title="配对 · 多对一"
        instruction="给每个单词选出词性。"
        left={WORDS_LEFT}
        right={POS_RIGHT}
        cardinality="many_to_one"
        leftHeading="单词"
        rightHeading="词性"
      />
    </div>
  );
}
