import type { ConfigValue } from './registry';

export type ConfigMutation =
  | { action: 'set'; key: string; value: ConfigValue }
  | { action: 'clear'; key: string };

export interface ConfigMutationResult {
  key: string;
  revision: number;
  epoch: number;
  action: 'set' | 'clear';
  cleared?: boolean;
}
