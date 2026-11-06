import { type ComponentType, createContext } from 'react';

export interface QuestionRefSlotProps {
  questionId: string;
  /** The block's fixed entry wording. */
  label: string;
}

/** A surface that can draw a question in place supplies this; elsewhere it stays a link. */
export const QuestionRefSlotContext = createContext<ComponentType<QuestionRefSlotProps> | null>(
  null,
);
