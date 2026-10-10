import type { HTMLAttributes } from 'react';

export interface UiNextRootProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Local theme override. Omit it to follow the app (`<html data-theme>`), and the system
   * preference when the app has none (T6).
   */
  theme?: 'light' | 'dark';
}

/** The scope every ui-next component must render inside: tokens and base rules attach here (I4). */
export function UiNextRoot({ theme, className, ...rest }: UiNextRootProps) {
  return (
    <div
      data-ui-next=""
      data-un-theme={theme}
      className={['un-root', className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
