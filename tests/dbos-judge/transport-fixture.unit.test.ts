import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import ts from 'typescript';
import { test } from 'vitest';

// Isolate the worker's catalog setup without importing its DB/service entrypoint.
// Real installed catalog/provider factories run here; no stream or auth operation runs.
function configuredFixture() {
  const source = ts.createSourceFile(
    'worker.ts',
    readFileSync(new URL('./worker.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const main = source.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'main',
  );
  assert.ok(main && ts.isFunctionDeclaration(main) && main.body);
  const declares = (statement: ts.Statement, name: string) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
    );
  const start = main.body.statements.findIndex((statement) => declares(statement, 'models'));
  const end = main.body.statements.findIndex((statement) => declares(statement, 'fetch'));
  assert.ok(start >= 0 && end > start);
  const setup = main.body.statements.slice(start, end);
  for (const statement of setup)
    assert.ok(
      declares(statement, 'models') ||
        declares(statement, 'model') ||
        (ts.isExpressionStatement(statement) &&
          /^models\.(?:getModel\s*=|setProvider\()/.test(statement.getText(source))),
      'Only catalog declarations and provider registration may execute offline',
    );
  const capture: {
    models?: ReturnType<typeof builtinModels>;
    registration?: Parameters<typeof createProvider>[0];
    completionsApi?: ReturnType<typeof openAICompletionsApi>;
  } = {};
  new Script(
    ts.transpileModule(setup.map((statement) => statement.getText(source)).join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
  ).runInNewContext({
    wire: new URL('http://127.0.0.1:1/v1'),
    builtinModels: () => {
      capture.models = builtinModels();
      return capture.models;
    },
    createProvider: (input: Parameters<typeof createProvider>[0]) => {
      capture.registration = input;
      return createProvider(input);
    },
    openAICompletionsApi: () => {
      capture.completionsApi = openAICompletionsApi();
      return capture.completionsApi;
    },
    envApiKeyAuth,
  });
  assert.ok(capture.models);
  return { ...capture, models: capture.models };
}

test('the adapter lookup and registered provider agree on the controlled model and endpoint', () => {
  const { models } = configuredFixture();
  const model = models.getModel('openai', 'gpt-4.1-mini');
  const provider = models.getProvider('openai');
  assert.ok(model && provider);
  assert.equal(model.api, 'openai-completions');
  assert.equal(
    provider.getModels().find((item) => item.id === model.id),
    model,
  );
  assert.equal(model.baseUrl, 'http://127.0.0.1:1/v1');
  assert.equal(provider.baseUrl, model.baseUrl);
  assert.equal(models.getModel('unregistered', 'gpt-4.1-mini'), undefined);
});

test('the registered provider uses the installed lazy Chat Completions API and native auth', () => {
  const { models, registration, completionsApi } = configuredFixture();
  assert.ok(registration && completionsApi);
  assert.equal(registration.api, completionsApi);
  const native = builtinModels();
  assert.ok(registration.auth.apiKey && native.getProvider('openai')?.auth.apiKey);
  assert.equal(
    registration.auth.apiKey?.resolve.toString(),
    native.getProvider('openai')?.auth.apiKey?.resolve.toString(),
  );
  const untouched = native.getProvider('anthropic')?.getModels()[0];
  assert.ok(untouched);
  assert.deepEqual(models.getModel('anthropic', untouched.id), untouched);
});
