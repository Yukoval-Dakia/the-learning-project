import { capabilities } from '@/capabilities';
import { assertProposalKindsOwned, validateComposition } from '@/kernel/manifest';
import { generateOpenApiDocument } from '@/kernel/openapi';

validateComposition(capabilities);
assertProposalKindsOwned(capabilities);
process.stdout.write(`${JSON.stringify(generateOpenApiDocument(capabilities), null, 2)}\n`);
