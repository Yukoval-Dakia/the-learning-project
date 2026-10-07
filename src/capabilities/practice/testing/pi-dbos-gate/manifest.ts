import { API_ERROR_RESPONSES } from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { type GateSql, arrangeNext, arrangeSchema, receiptSchema } from './operations';

// Only the gate's test composition consumes this manifest. Never added to capabilities/index.ts.
export function gateCapability(sql: GateSql) {
  return defineCapability({
    name: 'yuk1338-gate',
    description: 'Isolated state-version and recovery experiment; not a production capability.',
    api: {
      routes: [
        {
          method: 'POST',
          path: '/api/yuk1338-gate/arrange',
          operationId: 'gateArrangeNext',
          request: { body: arrangeSchema },
          responses: { 200: receiptSchema, ...API_ERROR_RESPONSES },
          successStatus: 200,
          load: async () => async (request) =>
            Response.json(await arrangeNext(sql, await request.json())),
        },
      ],
    },
  });
}
