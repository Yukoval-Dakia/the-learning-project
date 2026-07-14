import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { capabilities } from '@/capabilities';
import {
  type LegacyApiRouteAllowlist,
  assertApiRouteContractCoverage,
} from '@/kernel/api-contract-audit';
import { validateComposition } from '@/kernel/manifest';
import { generateOpenApiDocument } from '@/kernel/openapi';

const allowlistPath = resolve(process.cwd(), 'scripts/api-route-contract-legacy.json');
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as LegacyApiRouteAllowlist;

validateComposition(capabilities);
const report = assertApiRouteContractCoverage(capabilities, allowlist);
const document = generateOpenApiDocument(capabilities);
const pathCount = Object.keys(document.paths as Record<string, unknown>).length;

console.log(
  `API contract audit passed: ${report.declared}/${report.total} declared, ${report.legacy} legacy, ${pathCount} OpenAPI paths`,
);
