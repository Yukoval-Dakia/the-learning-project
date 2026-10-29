import type { ReactNode, Ref } from 'react';

/** Opaque owner-issued intent. The presenter never interprets it as a URL or command. */
export interface Action {
  id: string;
  label: string;
  availability: { kind: 'enabled' } | { kind: 'disabled' | 'busy'; reason: string };
}
export interface Notice {
  title: string;
  detail?: string;
  actions?: readonly Action[];
}
export type PageState =
  | { kind: 'loading' | 'recovering' | 'empty' | 'forbidden' | 'failed'; notice: Notice }
  | { kind: 'ready' | 'partial'; question: Question; missing?: Notice };
export type Content = {
  id: string;
  label: string;
  kind: 'text' | 'math' | 'media' | 'table' | 'code';
};
export interface Material {
  id: string;
  title: string;
  state:
    | { kind: 'ready'; content: Content }
    | { kind: 'loading' | 'failed' | 'missing'; notice: Notice };
}
interface FieldBase {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  mode: 'editable' | 'readonly' | 'disabled' | 'busy';
  reason?: string;
}
export type AnswerField = FieldBase &
  (
    | {
        kind: 'single' | 'multiple';
        options: readonly { id: string; key: string; content: Content }[];
        selected: readonly string[];
      }
    | { kind: 'text' | 'number' | 'formula'; value: string }
    | { kind: 'attachments'; accept?: string; multiple: boolean; items: readonly Attachment[] }
    | {
        kind: 'specialized';
        controlId: string;
        safety: { kind: 'approved'; boundaryId: string } | { kind: 'withheld'; reason: string };
      }
    | { kind: 'withheld'; reason: string }
  );
export interface Attachment {
  id: string;
  name: string;
  state:
    | { kind: 'uploading'; progress?: number }
    | { kind: 'complete' }
    | { kind: 'failed'; detail: string };
  actions: readonly Action[];
}
export type Draft =
  | { kind: 'restoring' | 'empty' | 'saving' | 'saved' | 'offline' | 'failed'; notice: Notice }
  | { kind: 'conflict'; notice: Notice; local: Content; remote: Content };
export interface Submission {
  recording: { kind: 'idle' | 'saving' | 'saved' | 'unknown' | 'failed'; notice?: Notice };
  grading: {
    kind: 'idle' | 'pending' | 'grading' | 'unknown' | 'failed' | 'settled' | 'manual';
    notice?: Notice;
  };
  continuation?: { kind: 'confirmation' | 'advancing'; notice: Notice };
  /** Optional: omit entirely for historical read-only answers. */
  primary?: Action;
  secondary: readonly Action[];
}
export interface SelfRating {
  label: string;
  value: string | null;
  options: readonly { id: string; label: string }[];
  disabled: boolean;
  reason?: string;
  actions: readonly Action[];
}
export interface Appeal {
  kind: 'available' | 'editing' | 'sending' | 'waiting' | 'failed' | 'resolved';
  notice: Notice;
  field?: AnswerField;
}
export interface Confidence {
  value: 1 | 2 | 3 | 4 | 5 | null;
  availability: Action['availability'];
  skip: Action;
  /** Selection is a confidence intent, never a self-rating or result reveal. */
  continue?: Action;
}
export type Revelation =
  | { kind: 'concealed'; confidence?: Confidence; reason?: string }
  | {
      kind: 'revealed';
      result?: Result;
      selfRating?: SelfRating;
      appeal?: Appeal;
      confidenceRecord?: string;
    };
export interface QuestionPart {
  id: string;
  label: string;
  stem: Content;
  materials: readonly Material[];
  fields: readonly AnswerField[];
}
export type Verdict = 'correct' | 'partial' | 'incorrect' | 'unanswered' | 'review' | 'unknown';
export interface Result {
  verdict: Verdict;
  summary: string;
  parts: readonly { id: string; label: string; verdict: Verdict; feedback?: Content }[];
  reference:
    | { kind: 'ready'; content: Content }
    | { kind: 'missing' | 'unavailable'; reason: string };
  evidence: readonly Content[];
  uncertainty?: string;
}
export interface Question {
  id: string;
  title: string;
  subject: string;
  progressLabel: string;
  estimatedTime?: string;
  source?: string;
  reason?: string;
  attemptLabel: string;
  stem: Content;
  materials: readonly Material[];
  fields: readonly AnswerField[];
  thought?: AnswerField;
  draft: Draft;
  submission: Submission;
  revelation: Revelation;
  parts: readonly QuestionPart[];
  supportActions: readonly Action[];
}
export interface Message {
  id: string;
  author: 'user' | 'assistant';
  delivery: 'queued' | 'sending' | 'acceptance-unknown' | 'accepted' | 'committed';
  state:
    | 'waiting'
    | 'streaming'
    | 'committed'
    | 'unknown'
    | 'partial'
    | 'refused'
    | 'failed'
    | 'cancelled';
  body?: Content;
  detail?: string;
  structures: readonly {
    id: string;
    kind: 'tool' | 'skill' | 'teaching' | 'proposal' | 'undo';
    content: Content;
    actions: readonly Action[];
  }[];
  sources: readonly Content[];
  actions: readonly Action[];
}
export interface Companion {
  open: boolean;
  summary:
    | { kind: 'loading' | 'empty' | 'failed'; notice: Notice }
    | { kind: 'ready'; content: Content };
  contexts: readonly { id: string; label: string; content: Content; remove: Action }[];
  newSession?: Action;
  teachingActions: readonly Action[];
  suggestionActions: readonly Action[];
  purpose: {
    value: 'learning' | 'this-answer' | null;
    state: 'ready' | 'validating' | 'unsupported' | 'rejected';
    reason?: string;
    options: Record<'learning' | 'this-answer', Action['availability']>;
  };
  sending: {
    kind:
      | 'idle'
      | 'queued'
      | 'sending'
      | 'acceptance-unknown'
      | 'accepted'
      | 'reading-back'
      | 'failed';
    notice?: Notice;
  };
  sessions:
    | { kind: 'loading' | 'empty' | 'failed'; notice: Notice }
    | {
        kind: 'ready';
        items: readonly { id: string; title: string; current: boolean; action: Action }[];
      };
  connection: {
    kind:
      | 'connected'
      | 'acceptance-unknown'
      | 'disconnected'
      | 'reconnecting'
      | 'refresh-failed'
      | 'confirmation';
    notice: Notice;
  };
  messages: readonly Message[];
  draft: string;
  editable: boolean;
  draftReason?: string;
  send: Action;
  stop?: {
    canStop: boolean;
    kind: 'idle' | 'requesting' | 'confirmed' | 'unknown' | 'failed';
    notice: Notice;
    action?: Action;
    consequence?: string;
  };
}
export interface PracticeView {
  theme: 'light' | 'dark';
  back: Action;
  navigation: { label: string; items: readonly { id: string; current: boolean; action: Action }[] };
  identity: string;
  page: PageState;
  companion: Companion;
  /** Short owner-deduplicated announcement; never the streaming body. */
  announcement: string;
  feedback?: Notice;
  blocking?: { id: string; title: string; body: string; confirm: Action; cancelLabel: string };
}
export interface Renderers {
  /** Safe rich text/math/media rendering, including alt text, captions and internal scroll accessibility. */
  content(content: Content): ReactNode;
  /** Structured tool result, supplied truthfully by its owner, not inferred from assistant prose. */
  structured(content: Content, kind: Message['structures'][number]['kind']): ReactNode;
  /** Only invoked for approved controls. Must honor mode/reason and the named safety boundary. */
  answer(control: {
    id: string;
    accessibleName: string;
    boundaryId: string;
    mode: FieldBase['mode'];
    reason?: string;
    describedBy: string;
    invalid: boolean;
    onIntent(payload: unknown): void;
  }): ReactNode;
}
export interface Intents {
  action(id: string): void;
  answer(fieldId: string, value: string | readonly string[]): void;
  attach(fieldId: string, files: readonly File[]): void;
  rating(value: string): void;
  confidence(value: 1 | 2 | 3 | 4 | 5): void;
  specializedAnswer(fieldId: string, payload: unknown): void;
  companionPurpose(value: 'learning' | 'this-answer'): void;
  companionDraft(value: string): void;
  companionOpen(open: boolean): void;
  theme(theme: 'light' | 'dark'): void;
  dismissBlocking(id: string): void;
}
export interface PracticePageProps {
  view: PracticeView;
  renderers: Renderers;
  intents: Intents;
  /** Stable refs: parent coordinates focus on identity transitions, never streaming renders. */
  /** Visible owner-rendered content; never mount a hidden legacy view to drive state. */
  surfaces?: {
    /** Frozen advanced presentation tree, mutually exclusive with native field layout. */
    questionBody?: ReactNode;
    conflict?: ReactNode;
    history?: ReactNode;
    overlays?: ReactNode;
    selectionActions?: ReactNode;
  };
  lifecycle?: {
    issuancePlaceholderRef?: Ref<HTMLElement>;
    answeringRootRef?: Ref<HTMLDivElement>;
    submitActionsRef?: Ref<HTMLDivElement>;
    resultRef?: Ref<HTMLDivElement>;
    quotableRef?: Ref<HTMLDivElement>;
    titleRef?: Ref<HTMLHeadingElement>;
    contentRef?: Ref<HTMLElement>;
    companionTitleRef?: Ref<HTMLHeadingElement>;
    companionTriggerRef?: Ref<HTMLButtonElement>;
  };
}

export type PracticeIntents = Pick<
  Intents,
  'action' | 'answer' | 'attach' | 'rating' | 'confidence' | 'specializedAnswer'
>;
export type PracticeRenderers = Pick<Renderers, 'content' | 'answer'>;
export type PracticeContentProps = Omit<PracticePageProps, 'view' | 'intents' | 'renderers'> & {
  view: Pick<PracticeView, 'identity' | 'page' | 'feedback'>;
  intents: PracticeIntents;
  renderers: PracticeRenderers;
};
