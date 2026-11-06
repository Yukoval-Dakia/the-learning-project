import type { ComponentType, ReactNode } from 'react';

export interface QuestionCardFrameProps {
  /** Nothing left to show: this one sentence is the whole card. */
  gone?: string;
  status?: { word: string; tone: 'waiting' | 'caution' | 'neutral' };
  note?: string | null;
  actions?: ReactNode;
  children?: ReactNode;
}

export interface QuestionCardRendererProps {
  questionId: string;
  label: string;
  sessionId: string;
  Frame: ComponentType<QuestionCardFrameProps>;
  /** Asks for another question in the learner's own words. */
  onAskAnother(): void;
}

export type QuestionCardRenderer = ComponentType<QuestionCardRendererProps>;
