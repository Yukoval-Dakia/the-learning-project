// Deterministic expression parser/evaluator for function plots.
//
// The grammar is closed: numbers, one independent variable, declared
// parameters, the constants pi/e, five operators and a fixed function table.
// There is no member access, no strings and no host evaluation (eval /
// new Function), so an expression can never reach a JS object. The AST walker
// calls Math.* only; the server validator and the browser scene run the same
// parser and therefore agree on what is valid and on every sampled value.

const FUNCTIONS = {
  sin: { min: 1, max: 1 },
  cos: { min: 1, max: 1 },
  tan: { min: 1, max: 1 },
  asin: { min: 1, max: 1 },
  acos: { min: 1, max: 1 },
  atan: { min: 1, max: 1 },
  sinh: { min: 1, max: 1 },
  cosh: { min: 1, max: 1 },
  tanh: { min: 1, max: 1 },
  sqrt: { min: 1, max: 1 },
  cbrt: { min: 1, max: 1 },
  abs: { min: 1, max: 1 },
  exp: { min: 1, max: 1 },
  ln: { min: 1, max: 1 },
  log10: { min: 1, max: 1 },
  log: { min: 1, max: 2 },
  floor: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  sign: { min: 1, max: 1 },
  min: { min: 2, max: 8 },
  max: { min: 2, max: 8 },
} as const;

export type ExprFunctionName = keyof typeof FUNCTIONS;

export type ExprNode =
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'variable'; readonly name: string }
  | { readonly type: 'negate'; readonly operand: ExprNode }
  | {
      readonly type: 'binary';
      readonly op: BinaryOperator;
      readonly left: ExprNode;
      readonly right: ExprNode;
    }
  | { readonly type: 'call'; readonly name: ExprFunctionName; readonly args: readonly ExprNode[] };

type BinaryOperator = '+' | '-' | '*' | '/' | '^';

export type ExprIssueCode = 'expr_parse_error' | 'expr_unknown_identifier' | 'expr_too_complex';

export type ExprIssue = {
  readonly code: ExprIssueCode;
  readonly detail: string;
  /** 1-based character column in the submitted expression. */
  readonly column: number;
  readonly expected?: readonly string[];
};

export type ExprParseResult =
  | { readonly ok: true; readonly ast: ExprNode }
  | { readonly ok: false; readonly issue: ExprIssue };

type Token =
  | { readonly kind: 'number'; readonly value: number; readonly start: number }
  | { readonly kind: 'identifier'; readonly name: string; readonly start: number }
  | {
      readonly kind: 'operator';
      readonly op: BinaryOperator | '(' | ')' | ',';
      readonly start: number;
    }
  | { readonly kind: 'end'; readonly start: number };

const BINARY_PRECEDENCE: Record<BinaryOperator, number> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  '^': 4,
};

/** Unary minus binds tighter than * but looser than ^: -x^2 is -(x^2). */
const PREFIX_PRECEDENCE = 3;
const MAX_AST_NODES = 256;
const MAX_POWER_DEPTH = 3;
const MAX_SOURCE_LENGTH = 200;

class ParseFailure {
  constructor(readonly issue: ExprIssue) {}
}

function fail(
  code: ExprIssueCode,
  detail: string,
  column: number,
  expected?: readonly string[],
): never {
  throw new ParseFailure({ code, detail, column, ...(expected ? { expected } : {}) });
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    const start = index;
    const numberMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index));
    if (numberMatch) {
      const value = Number(numberMatch[0]);
      if (!Number.isFinite(value)) {
        fail('expr_parse_error', 'number literal must be finite', start + 1, ['finite number']);
      }
      tokens.push({ kind: 'number', value, start });
      index += numberMatch[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
      tokens.push({ kind: 'identifier', name: source.slice(index, end), start });
      index = end;
      continue;
    }
    if ('+-*/^(),'.includes(char)) {
      tokens.push({ kind: 'operator', op: char as BinaryOperator | '(' | ')' | ',', start });
      index += 1;
      continue;
    }
    fail('expr_parse_error', `unexpected character '${char}'`, start + 1, [
      'number',
      'variable',
      'function',
      '(',
      ')',
      'operator',
    ]);
  }
  tokens.push({ kind: 'end', start: source.length });
  return tokens;
}

function startsImplicitMultiplication(previous: Token, next: Token): boolean {
  if (previous.kind === 'number' && next.kind === 'identifier') return true;
  return (
    previous.kind === 'operator' &&
    previous.op === ')' &&
    next.kind === 'operator' &&
    next.op === '('
  );
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly variables: ReadonlySet<string>,
  ) {}

  parse(): ExprNode {
    const node = this.parseExpression(1);
    const rest = this.peek();
    if (rest.kind !== 'end') {
      if (rest.kind === 'operator' && rest.op === '(') {
        fail(
          'expr_parse_error',
          "implicit multiplication only covers 2x and (...) (...), write '*' explicitly",
          rest.start + 1,
          ['*'],
        );
      }
      fail('expr_parse_error', 'unexpected token after the expression', rest.start + 1, [
        'operator',
        'end of expression',
      ]);
    }
    return node;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private advance(): Token {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  private expectOperator(operator: ')'): void {
    const token = this.peek();
    if (token.kind === 'operator' && token.op === operator) {
      this.index += 1;
      return;
    }
    fail('expr_parse_error', `expected '${operator}'`, token.start + 1, [operator]);
  }

  private parseExpression(minPrecedence: number): ExprNode {
    let left = this.parsePrefix();
    for (;;) {
      const token = this.peek();
      let operator: BinaryOperator | null = null;
      const previous = this.tokens[this.index - 1];
      let implicit = false;
      if (token.kind === 'operator' && ['+', '-', '*', '/', '^'].includes(token.op)) {
        operator = token.op as BinaryOperator;
      } else if (startsImplicitMultiplication(previous, token)) {
        operator = '*';
        implicit = true;
      }
      if (operator === null) break;
      const precedence = BINARY_PRECEDENCE[operator];
      if (precedence < minPrecedence) break;
      if (!implicit) this.index += 1;
      // ^ is right-associative; the other operators are left-associative.
      const right = this.parseExpression(operator === '^' ? precedence : precedence + 1);
      left = { type: 'binary', op: operator, left, right };
    }
    return left;
  }

  private parsePrefix(): ExprNode {
    const token = this.advance();
    if (token.kind === 'number') {
      return { type: 'number', value: token.value };
    }
    if (token.kind === 'identifier') {
      const next = this.peek();
      if (next.kind === 'operator' && next.op === '(') {
        if (this.variables.has(token.name)) {
          fail(
            'expr_parse_error',
            `'${token.name}' is a variable, not a function; write ${token.name}*(...) to multiply`,
            token.start + 1,
            ['*'],
          );
        }
        return this.parseCall(token);
      }
      if (token.name === 'pi') return { type: 'number', value: Math.PI };
      if (token.name === 'e') return { type: 'number', value: Math.E };
      if (this.variables.has(token.name)) return { type: 'variable', name: token.name };
      fail(
        'expr_unknown_identifier',
        `'${token.name}' is not a declared variable`,
        token.start + 1,
        [...this.variables, 'pi', 'e'],
      );
    }
    if (token.kind === 'operator') {
      if (token.op === '-') {
        return { type: 'negate', operand: this.parseExpression(PREFIX_PRECEDENCE) };
      }
      if (token.op === '(') {
        const inner = this.parseExpression(1);
        this.expectOperator(')');
        return inner;
      }
    }
    fail('expr_parse_error', 'expected a number, variable, function or (', token.start + 1, [
      'number',
      'variable',
      'function',
      '(',
    ]);
  }

  private parseCall(nameToken: Extract<Token, { kind: 'identifier' }>): ExprNode {
    const name = nameToken.name;
    if (!Object.hasOwn(FUNCTIONS, name)) {
      fail(
        'expr_unknown_identifier',
        `'${name}' is not a supported function`,
        nameToken.start + 1,
        Object.keys(FUNCTIONS),
      );
    }
    const functionName = name as ExprFunctionName;
    const spec = FUNCTIONS[functionName];
    this.index += 1; // consume '('
    const first = this.peek();
    if (first.kind === 'operator' && first.op === ')') {
      fail('expr_parse_error', `${functionName} needs arguments`, nameToken.start + 1, [
        'argument',
      ]);
    }
    const args: ExprNode[] = [];
    for (;;) {
      args.push(this.parseExpression(1));
      const next = this.peek();
      if (next.kind === 'operator' && next.op === ',') {
        this.index += 1;
        continue;
      }
      break;
    }
    this.expectOperator(')');
    if (args.length < spec.min || args.length > spec.max) {
      const expected = spec.min === spec.max ? `${spec.min}` : `${spec.min}..${spec.max}`;
      fail(
        'expr_parse_error',
        `${functionName} expects ${expected} argument(s), received ${args.length}`,
        nameToken.start + 1,
        [expected],
      );
    }
    return { type: 'call', name: functionName, args };
  }
}

function countNodes(node: ExprNode): number {
  switch (node.type) {
    case 'number':
    case 'variable':
      return 1;
    case 'negate':
      return 1 + countNodes(node.operand);
    case 'binary':
      return 1 + countNodes(node.left) + countNodes(node.right);
    case 'call':
      return 1 + node.args.reduce((total, arg) => total + countNodes(arg), 0);
  }
}

function powerDepth(node: ExprNode): number {
  switch (node.type) {
    case 'number':
    case 'variable':
      return 0;
    case 'negate':
      return powerDepth(node.operand);
    case 'binary': {
      const inner = Math.max(powerDepth(node.left), powerDepth(node.right));
      return node.op === '^' ? inner + 1 : inner;
    }
    case 'call':
      return node.args.reduce((depth, arg) => Math.max(depth, powerDepth(arg)), 0);
  }
}

/**
 * Parse one expression against the variables the block declares. Variables is
 * exactly the set that may appear by name; pi and e are constants, never
 * variables.
 */
export function parseExpression(source: string, variables: ReadonlySet<string>): ExprParseResult {
  if (source.length > MAX_SOURCE_LENGTH) {
    return {
      ok: false,
      issue: {
        code: 'expr_too_complex',
        detail: `expression exceeds ${MAX_SOURCE_LENGTH} characters`,
        column: MAX_SOURCE_LENGTH + 1,
      },
    };
  }
  try {
    const ast = new Parser(tokenize(source), variables).parse();
    if (countNodes(ast) > MAX_AST_NODES) {
      return {
        ok: false,
        issue: {
          code: 'expr_too_complex',
          detail: `expression exceeds ${MAX_AST_NODES} AST nodes`,
          column: 1,
        },
      };
    }
    if (powerDepth(ast) > MAX_POWER_DEPTH) {
      return {
        ok: false,
        issue: {
          code: 'expr_too_complex',
          detail: `power tower depth exceeds ${MAX_POWER_DEPTH}`,
          column: 1,
        },
      };
    }
    return { ok: true, ast };
  } catch (error) {
    if (error instanceof ParseFailure) return { ok: false, issue: error.issue };
    throw error;
  }
}

function evaluateCall(name: ExprFunctionName, args: readonly number[]): number {
  switch (name) {
    case 'sin':
      return Math.sin(args[0]);
    case 'cos':
      return Math.cos(args[0]);
    case 'tan':
      return Math.tan(args[0]);
    case 'asin':
      return Math.asin(args[0]);
    case 'acos':
      return Math.acos(args[0]);
    case 'atan':
      return Math.atan(args[0]);
    case 'sinh':
      return Math.sinh(args[0]);
    case 'cosh':
      return Math.cosh(args[0]);
    case 'tanh':
      return Math.tanh(args[0]);
    case 'sqrt':
      return Math.sqrt(args[0]);
    case 'cbrt':
      return Math.cbrt(args[0]);
    case 'abs':
      return Math.abs(args[0]);
    case 'exp':
      return Math.exp(args[0]);
    case 'ln':
      return args[0] > 0 ? Math.log(args[0]) : Number.NaN;
    case 'log10':
      return args[0] > 0 ? Math.log10(args[0]) : Number.NaN;
    case 'log': {
      if (args.length === 1) return args[0] > 0 ? Math.log(args[0]) : Number.NaN;
      const [base, value] = args;
      if (!(base > 0) || base === 1 || !(value > 0)) return Number.NaN;
      return Math.log(value) / Math.log(base);
    }
    case 'floor':
      return Math.floor(args[0]);
    case 'ceil':
      return Math.ceil(args[0]);
    case 'sign':
      return Math.sign(args[0]);
    case 'min':
      return Math.min(...args);
    case 'max':
      return Math.max(...args);
  }
}

/** Closed AST walk with Math.* only. Non-finite results are returned, not thrown. */
export function evaluateExpression(
  node: ExprNode,
  values: Readonly<Record<string, number>>,
): number {
  switch (node.type) {
    case 'number':
      return node.value;
    case 'variable': {
      const value = values[node.name];
      return value === undefined ? Number.NaN : value;
    }
    case 'negate':
      return -evaluateExpression(node.operand, values);
    case 'binary': {
      const left = evaluateExpression(node.left, values);
      const right = evaluateExpression(node.right, values);
      switch (node.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return left / right;
        case '^':
          return left ** right;
      }
      return Number.NaN;
    }
    case 'call': {
      const args = node.args.map((arg) => evaluateExpression(arg, values));
      return evaluateCall(node.name, args);
    }
  }
}
