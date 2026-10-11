import type { HTMLAttributes } from 'react';
import type { MascotMode } from '../mascot/MascotLayer';
import { MascotProvider } from '../mascot/MascotProvider';

export interface UiNextRootProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Local theme override. Omit it to follow the app (`<html data-theme>`), and the system
   * preference when the app has none (T6).
   */
  theme?: 'light' | 'dark';
  /**
   * The one mascot for everything inside (B1). `auto` draws the glass flower where the device can
   * afford it and the still flower elsewhere; `still` always uses the still flower; `off` renders
   * none. Nothing loads until a page declares a <MascotSlot>.
   */
  mascot?: MascotMode;
}

/** The scope every ui-next component must render inside: tokens and base rules attach here (I4). */
export function UiNextRoot({
  theme,
  mascot = 'auto',
  className,
  children,
  ...rest
}: UiNextRootProps) {
  return (
    <div
      data-ui-next=""
      data-un-theme={theme}
      className={['un-root', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <MascotProvider mode={mascot}>{children}</MascotProvider>
    </div>
  );
}
