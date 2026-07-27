import { readFile, writeFile } from 'node:fs/promises';
import openapiTS, { COMMENT_HEADER, astToString } from 'openapi-typescript';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('usage: node generate.mjs <openapi-json> <output-ts>');
}

const schema = JSON.parse(await readFile(inputPath, 'utf8'));
const ast = await openapiTS(schema, {
  alphabetize: true,
  silent: true,
});
await writeFile(outputPath, `${COMMENT_HEADER}${astToString(ast)}`, 'utf8');
