import './blocks.css';
import type { HTMLAttributes } from 'react';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** A quieter card on the sunk background (secondary information). */
  tone?: 'raised' | 'sunk';
  as?: 'article' | 'section' | 'div';
}

/** A content card: raised paper with a hairline, no shadow (cards never cast shadows, T3). */
export function Card({ tone = 'raised', as: Tag = 'div', className, ...rest }: CardProps) {
  return (
    <Tag
      className={['un-card', `un-card-${tone}`, className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
