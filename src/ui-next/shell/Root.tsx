import type { HTMLAttributes, Ref } from 'react';

export interface UiNextRootProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Local theme override. Omit it to follow the app (`<html data-theme>`), and the system
   * preference when the app has none (T6).
   */
  theme?: 'light' | 'dark';
  /** A ref callback lets the scope's own node own a lifetime (attach/detach) without an effect. */
  ref?: Ref<HTMLDivElement>;
}

/** The scope every ui-next component must render inside: tokens and base rules attach here (I4). */
export function UiNextRoot({ theme, className, ref, ...rest }: UiNextRootProps) {
  return (
    <div
      ref={ref}
      data-ui-next=""
      data-un-theme={theme}
      className={['un-root', className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
