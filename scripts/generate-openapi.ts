import { capabilities } from '@/capabilities';
import { validateComposition } from '@/kernel/manifest';
import { generateOpenApiDocument } from '@/kernel/openapi';

validateComposition(capabilities);
process.stdout.write(`${JSON.stringify(generateOpenApiDocument(capabilities), null, 2)}\n`);
