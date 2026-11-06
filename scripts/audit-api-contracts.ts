import { capabilities } from '@/capabilities';
import { assertApiRouteContractCoverage } from '@/kernel/api-contract-audit';
import { assertProposalKindsOwned, validateComposition } from '@/kernel/manifest';
import { generateOpenApiDocument } from '@/kernel/openapi';

validateComposition(capabilities);
assertProposalKindsOwned(capabilities);
const report = assertApiRouteContractCoverage(capabilities);
const document = generateOpenApiDocument(capabilities);
const pathCount = Object.keys(document.paths as Record<string, unknown>).length;

console.log(
  `API contract audit passed: ${report.declared}/${report.total} declared, ${report.undeclared} undeclared, ${pathCount} OpenAPI paths`,
);
