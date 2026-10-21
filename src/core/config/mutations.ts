import type { ConfigValue } from './registry';

export type ConfigMutation =
  | {
      action: 'set';
      key: string;
      value: ConfigValue;
      /** YUK-1557 — optional hard stop for temporary overrides (ISO instant). */
      expiresAt?: string | null;
    }
  | { action: 'clear'; key: string };

export interface ConfigMutationResult {
  key: string;
  revision: number;
  epoch: number;
  action: 'set' | 'clear';
  cleared?: boolean;
}
