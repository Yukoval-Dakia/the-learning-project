import { describe, expect, it } from 'vitest';

import { SERVER_ENV_KEYS } from '@/server/env';
import { collectEnvInventory, missingEnvSchemaKeys } from '../../scripts/audit-env-inventory';

describe('server environment inventory', () => {
  it('declares every production env consumer in the shared schema', () => {
    // Given
    const inventory = collectEnvInventory(process.cwd());

    // When
    const missing = missingEnvSchemaKeys(inventory, SERVER_ENV_KEYS);

    // Then
    expect(missing).toEqual([]);
  });
});
