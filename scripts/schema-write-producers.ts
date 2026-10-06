/** Additional statically provable producers: executed SQL and generated DB values. */
import ts from 'typescript';
import type { WriteStatement } from './audit-schema-writes';

function sourceFile(source: string): ts.SourceFile {
  return ts.createSourceFile('input.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function payload(columns: string[]): string {
  return `{${columns.map((column) => `${column}: true`).join(',')}}`;
}

// Strip SQL values/comments before matching syntax. Interpolations are value
// placeholders, never identifiers; a dynamic table/column therefore cannot pass.
function staticSql(template: ts.TemplateLiteral): string {
  const text = ts.isNoSubstitutionTemplateLiteral(template)
    ? template.text
    : template.head.text + template.templateSpans.map((span) => ` ? ${span.literal.text}`).join('');
  return text.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\$([a-z_][\w]*|)\$[\s\S]*?\$\1\$/gi,
    ' ',
  );
}

// Parenthesized subqueries/functions cannot contribute assignments or WHERE
// boundaries to their enclosing UPDATE. Preserve offsets and top-level commas.
function topLevelSql(sql: string): string {
  let depth = 0;
  let result = '';
  for (const char of sql) {
    if (char === '(') depth++;
    result += depth === 0 ? char : ' ';
    if (char === ')') depth--;
  }
  return result;
}

export function extractExecutedSqlWrites(source: string): WriteStatement[] {
  const statements: WriteStatement[] = [];
  const file = sourceFile(source);
  const visit = (node: ts.Node): void => {
    // Only SQL directly submitted to execute counts. Documentation, strings,
    // unused sql fragments and dynamic identifier expressions are not writers.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'execute'
    ) {
      const arg = node.arguments[0];
      if (
        arg &&
        ts.isTaggedTemplateExpression(arg) &&
        ts.isIdentifier(arg.tag) &&
        arg.tag.text === 'sql'
      ) {
        const sql = staticSql(arg.template);
        for (const match of sql.matchAll(
          /\binsert\s+into\s+([a-z_][\w]*)\s*(?:\(([^()]*)\)\s*)?(?:default\s+values|values|select)\b/gi,
        )) {
          const columns = match[2]?.split(',').map((column) => column.trim()) ?? [];
          statements.push({
            kind: 'insert',
            table: match[1],
            payload: payload(
              columns.every((column) => /^[a-z_][\w]*$/i.test(column)) ? columns : [],
            ),
          });
        }
        const top = topLevelSql(sql);
        for (const match of top.matchAll(
          /\bupdate\s+([a-z_][\w]*)(?:\s+(?:as\s+)?(?!set\b)[a-z_][\w]*)?\s+set\s+([\s\S]*?)(?=\b(?:where|from|returning)\b|;|$)/gi,
        )) {
          const columns = match[2].split(',').flatMap((assignment) => {
            const column = /^\s*([a-z_][\w]*)\s*=/.exec(assignment)?.[1];
            return column ? [column] : [];
          });
          statements.push({ kind: 'update', table: match[1], payload: payload(columns) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return statements;
}

/** Sequence/time expressions generate values on INSERT; literals are not a producer. */
export function extractDatabaseGeneratedWrites(source: string): WriteStatement[] {
  const statements: WriteStatement[] = [];
  const file = sourceFile(source);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'pgTable'
    ) {
      const [name, fields] = node.arguments;
      if (name && ts.isStringLiteral(name) && fields && ts.isObjectLiteralExpression(fields)) {
        for (const field of fields.properties) {
          if (!ts.isPropertyAssignment(field) || !ts.isIdentifier(field.name)) continue;
          let expression: ts.Expression = field.initializer;
          let generated = false;
          while (
            ts.isCallExpression(expression) &&
            ts.isPropertyAccessExpression(expression.expression)
          ) {
            const method = expression.expression.name.text;
            const arg = expression.arguments[0];
            generated ||= method === 'defaultNow' && expression.arguments.length === 0;
            if (
              method === 'default' &&
              arg &&
              ts.isTaggedTemplateExpression(arg) &&
              ts.isIdentifier(arg.tag) &&
              arg.tag.text === 'sql' &&
              ts.isNoSubstitutionTemplateLiteral(arg.template)
            ) {
              generated ||= /^nextval\('[a-z_][\w]*'\)$/.test(arg.template.text.trim());
            }
            expression = expression.expression.expression;
          }
          if (generated)
            statements.push({
              kind: 'insert',
              table: name.text,
              payload: payload([field.name.text]),
            });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return statements;
}
