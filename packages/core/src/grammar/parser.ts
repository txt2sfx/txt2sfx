/**
 * soundline parser: tokens -> {@link SoundAST}.
 *
 * The grammar is strictly line-oriented, which buys a cheap and very useful
 * property: **error recovery is per line**. One malformed layer does not hide
 * the three mistakes below it, so a single agent iteration can fix all of them.
 * {@link parse} throws the first error (the strict path used by the compiler),
 * {@link parseWithDiagnostics} returns every error it found (the path used by
 * the editor and by the agent loop).
 *
 * Only arguments that were actually written land in the AST — defaults are
 * applied later, by the compiler. That is what makes serialization lossless.
 *
 * @packageDocumentation
 */

import type {
  ArgValue,
  EffectNode,
  EnvelopeNode,
  LayerNode,
  Loc,
  NumberLiteral,
  ParamSpec,
  RampSegment,
  Signature,
  SlotRange,
  SoundAST,
  SoundCategory,
  SourceNode,
  Unit,
} from '@txt2sfx/shared';
import { SOUND_CATEGORIES } from '@txt2sfx/shared';
import { SoundlineError, didYouMean, expectedList } from './errors.js';
import { describeToken, tokenize, type Token } from './lexer.js';
import { EFFECTS, EFFECT_NAMES, ENVELOPE, PRIMITIVES, PRIMITIVE_NAMES } from './signatures.js';
import { convertUnit, describeUnits, formatNumber, unitAllowed } from './units.js';

/** Outcome of a lenient parse. */
export interface ParseResult {
  /** The document, or `null` when even the header could not be read. */
  readonly ast: SoundAST | null;
  /** Every error found; at most one per source line. */
  readonly errors: readonly SoundlineError[];
}

/* ------------------------------------------------------------------------- *
 * Line grouping
 * ------------------------------------------------------------------------- */

interface LogicalLine {
  readonly tokens: readonly Token[];
  readonly comment: Token | undefined;
  readonly line: number;
}

function groupLines(tokens: readonly Token[]): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let current: Token[] = [];
  let comment: Token | undefined;
  let lineNo = 1;

  const flush = (): void => {
    if (current.length > 0 || comment !== undefined) {
      lines.push({ tokens: current, comment, line: lineNo });
    }
    current = [];
    comment = undefined;
  };

  for (const token of tokens) {
    if (token.type === 'eof') break;
    if (token.type === 'newline') {
      flush();
      lineNo = token.loc.line + 1;
      continue;
    }
    if (current.length === 0 && comment === undefined) lineNo = token.loc.line;
    if (token.type === 'comment') {
      comment = token;
      continue;
    }
    current.push(token);
  }
  flush();
  return lines;
}

/* ------------------------------------------------------------------------- *
 * Cursor
 * ------------------------------------------------------------------------- */

/** Reader over the tokens of a single logical line. */
class Cursor {
  private pos = 0;
  private readonly end: Token;

  constructor(private readonly tokens: readonly Token[], line: number) {
    const last = tokens[tokens.length - 1];
    const loc: Loc =
      last === undefined
        ? { line, column: 1, offset: 0, length: 0 }
        : {
            line: last.loc.line,
            column: last.loc.column + last.loc.length,
            offset: last.loc.offset + last.loc.length,
            length: 0,
          };
    this.end = { type: 'newline', text: '', loc };
  }

  peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? this.end;
  }

  next(): Token {
    const token = this.peek();
    if (this.pos < this.tokens.length) this.pos += 1;
    return token;
  }

  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  error(token: Token, code: string, detail: string, hint?: string): SoundlineError {
    return new SoundlineError({
      code,
      detail,
      loc: token.loc,
      ...(hint === undefined ? {} : { hint }),
    });
  }
}

/* ------------------------------------------------------------------------- *
 * Values
 * ------------------------------------------------------------------------- */

const TIME_SPEC: ParamSpec = { name: 'in', kind: 'time', doc: 'ramp duration' };

function checkUnit(cur: Cursor, token: Token, spec: ParamSpec, owner: string): void {
  const unit = (token.unit ?? '') as Unit;
  if (unitAllowed(spec.kind, unit)) return;
  if (unit === '') {
    throw cur.error(
      token,
      'unit.missing',
      `expected unit (${describeUnits(spec.kind)}) after number for '${spec.name}' of ${owner}`,
      'every number in a soundline carries its unit',
    );
  }
  if (spec.kind === 'ratio') {
    throw cur.error(
      token,
      'unit.unexpected',
      `parameter '${spec.name}' of ${owner} is dimensionless — remove the unit '${unit}'`,
      `write '${spec.name} ${formatNumber(token.value ?? 0)}'`,
    );
  }
  throw cur.error(
    token,
    'unit.wrong',
    `expected unit (${describeUnits(spec.kind)}) after number for '${spec.name}' of ${owner}, got '${unit}'`,
  );
}

function parseSlot(cur: Cursor, head: Token, owner: string): SlotRange {
  const open = cur.peek();
  if (open.type !== 'lbracket') {
    throw cur.error(
      open,
      'slot.range-missing',
      `'~' marks an optimizable value and needs a range in ${owner}`,
      'write it as ~3200Hz[500..8000]',
    );
  }
  cur.next();
  const minTok = cur.next();
  if (minTok.type !== 'number') {
    throw cur.error(minTok, 'slot.bound', `expected the lower bound of the slot range, got ${describeToken(minTok)}`);
  }
  const dots = cur.next();
  if (dots.type !== 'dotdot') {
    throw cur.error(dots, 'slot.dots', `expected '..' between the slot bounds, got ${describeToken(dots)}`);
  }
  const maxTok = cur.next();
  if (maxTok.type !== 'number') {
    throw cur.error(maxTok, 'slot.bound', `expected the upper bound of the slot range, got ${describeToken(maxTok)}`);
  }
  const close = cur.next();
  if (close.type !== 'rbracket') {
    throw cur.error(close, 'slot.unclosed', `expected ']' to close the slot range, got ${describeToken(close)}`);
  }

  /* A bound is read in the unit of the value it bounds, so a bare number is the
     canonical form. A bound that repeats a *scalable* unit of the same kind is
     converted rather than rejected: `~500ms[200ms..1s]` is what a model writes
     when the range crosses a round second, and refusing it costs a whole repair
     iteration to change nothing about the meaning. What stays an error is a
     bound that cannot be rewritten — another kind, or dB against a linear gain. */
  const headUnit = (head.unit ?? '') as Unit;
  const bounds: number[] = [];
  for (const bound of [minTok, maxTok]) {
    const unit = (bound.unit ?? '') as Unit;
    const raw = bound.value ?? 0;
    if (unit === '' || unit === headUnit) {
      bounds.push(raw);
      continue;
    }
    const converted = convertUnit(raw, unit, headUnit);
    if (converted === undefined) {
      throw cur.error(
        bound,
        'slot.unit-mismatch',
        `slot bounds use the unit of the value ('${headUnit}'), got '${unit}'`,
        'bounds may be written bare: ~3200Hz[500..8000]',
      );
    }
    bounds.push(converted);
  }

  const min = bounds[0] ?? 0;
  const max = bounds[1] ?? 0;
  if (!(min < max)) {
    throw cur.error(
      minTok,
      'slot.range-order',
      `slot range must increase, got [${formatNumber(min)}..${formatNumber(max)}]`,
    );
  }
  const value = head.value ?? 0;
  if (value < min || value > max) {
    throw cur.error(
      head,
      'slot.start-outside',
      `slot start ${formatNumber(value)} is outside its range [${formatNumber(min)}..${formatNumber(max)}]`,
      'the start value is the optimizer seed and must lie inside the range',
    );
  }
  /* The bound spans travel with the range so a transform can rewrite the bounds
     in the same pass as the value they bound. They are the *token* spans: a bound
     written `1s` against a `ms` value keeps its own span here while `min`/`max`
     hold the converted number, which is exactly what a rewrite needs. */
  return { min, max, minLoc: minTok.loc, maxLoc: maxTok.loc };
}

function parseLiteral(cur: Cursor, spec: ParamSpec, owner: string): NumberLiteral {
  const first = cur.peek();
  const isSlot = first.type === 'tilde';
  if (isSlot) cur.next();

  const token = cur.next();
  if (token.type !== 'number') {
    if (token.type === 'lbracket') {
      throw cur.error(
        token,
        'slot.no-tilde',
        `a range '[...]' must follow a '~' value in ${owner}`,
        'write ~3200Hz[500..8000]',
      );
    }
    throw cur.error(
      token,
      'value.expected',
      `expected a number for '${spec.name}' of ${owner}, got ${describeToken(token)}`,
    );
  }
  checkUnit(cur, token, spec, owner);

  const slot = isSlot ? parseSlot(cur, token, owner) : undefined;
  return {
    value: token.value ?? 0,
    unit: (token.unit ?? '') as Unit,
    ...(slot === undefined ? {} : { slot }),
    loc: token.loc,
  };
}

function parseRamp(cur: Cursor, spec: ParamSpec, owner: string): RampSegment[] {
  const segments: RampSegment[] = [];
  while (cur.peek().type === 'arrow') {
    const arrow = cur.next();
    if (spec.rampable !== true) {
      throw cur.error(
        arrow,
        'ramp.unsupported',
        `parameter '${spec.name}' of ${owner} cannot ramp`,
        'only frequency-like and index parameters accept "-> value in time"',
      );
    }
    let curve: 'exp' | 'lin' = 'exp';
    const maybeCurve = cur.peek();
    if (maybeCurve.type === 'ident' && (maybeCurve.text === 'lin' || maybeCurve.text === 'exp')) {
      curve = maybeCurve.text;
      cur.next();
    }
    const to = parseLiteral(cur, spec, owner);
    const inTok = cur.next();
    if (inTok.type !== 'ident' || inTok.text !== 'in') {
      throw cur.error(
        inTok,
        'ramp.in-missing',
        `expected 'in <time>' after the ramp target of '${spec.name}' in ${owner}, got ${describeToken(inTok)}`,
        'a ramp always states how long it takes, e.g. -> 80Hz in 12ms',
      );
    }
    const time = parseLiteral(cur, TIME_SPEC, owner);
    segments.push({ curve, to, time, loc: arrow.loc });
  }
  return segments;
}

function parseList(cur: Cursor, spec: ParamSpec, owner: string): ArgValue {
  const values: number[] = [];
  const first = cur.next();
  if (first.type !== 'number') {
    throw cur.error(
      first,
      'list.expected',
      `expected a colon-separated number list for '${spec.name}' of ${owner}, got ${describeToken(first)}`,
      'e.g. ratios 1:2.41:3.86',
    );
  }
  if ((first.unit ?? '') !== '') {
    throw cur.error(first, 'list.unit', `'${spec.name}' of ${owner} holds bare ratios — remove the unit`);
  }
  values.push(first.value ?? 0);
  while (cur.peek().type === 'colon') {
    cur.next();
    const next = cur.next();
    if (next.type !== 'number' || (next.unit ?? '') !== '') {
      throw cur.error(next, 'list.expected', `expected a bare number after ':' in '${spec.name}' of ${owner}`);
    }
    values.push(next.value ?? 0);
  }
  if (values.length < 2) {
    throw cur.error(
      first,
      'list.too-short',
      `'${spec.name}' of ${owner} needs at least two values`,
      'e.g. ratios 1:2.41:3.86',
    );
  }
  return { kind: 'list', values, loc: first.loc };
}

function parseArgValue(cur: Cursor, spec: ParamSpec, owner: string): ArgValue {
  if (spec.kind === 'enum') {
    const token = cur.next();
    const allowed = spec.values ?? [];
    if (token.type !== 'ident' || !allowed.includes(token.text)) {
      const guess = token.type === 'ident' ? didYouMean(token.text, allowed) : undefined;
      throw cur.error(
        token,
        'enum.invalid',
        `expected ${spec.name} (${expectedList(allowed)}) in ${owner}, got ${describeToken(token)}`,
        guess === undefined ? undefined : `did you mean '${guess}'?`,
      );
    }
    return { kind: 'enum', value: token.text, loc: token.loc };
  }
  if (spec.kind === 'list') return parseList(cur, spec, owner);

  const head = parseLiteral(cur, spec, owner);
  const ramp = parseRamp(cur, spec, owner);
  return { kind: 'number', head, ramp, loc: head.loc };
}

/* ------------------------------------------------------------------------- *
 * Argument lists
 * ------------------------------------------------------------------------- */

function argsEnd(cur: Cursor): boolean {
  const t = cur.peek();
  return cur.atEnd() || t.type === 'pipe' || t.type === 'chain' || t.type === 'newline';
}

function parseArgs(cur: Cursor, sig: Signature, owner: string): Record<string, ArgValue> {
  const args: Record<string, ArgValue> = {};

  for (const spec of sig.params) {
    if (spec.positional !== true) continue;
    if (spec.kind === 'enum') {
      // An optional positional enum is recognised by its value, so `modal 1450Hz`
      // and `modal wood 1450Hz` are both unambiguous.
      const token = cur.peek();
      const allowed = spec.values ?? [];
      if (token.type === 'ident' && allowed.includes(token.text)) {
        args[spec.name] = parseArgValue(cur, spec, owner);
      } else if (spec.required === true) {
        const guess = token.type === 'ident' ? didYouMean(token.text, allowed) : undefined;
        throw cur.error(
          token,
          'enum.invalid',
          `expected ${spec.name} (${expectedList(allowed)}) in ${owner}, got ${describeToken(token)}`,
          guess === undefined ? undefined : `did you mean '${guess}'?`,
        );
      }
      continue;
    }
    if (argsEnd(cur)) {
      if (spec.required !== true) continue;
      throw cur.error(
        cur.peek(),
        'arg.missing',
        `${owner} needs '${spec.name}' (${describeUnits(spec.kind)}), got ${describeToken(cur.peek())}`,
      );
    }
    args[spec.name] = parseArgValue(cur, spec, owner);
  }

  while (!argsEnd(cur)) {
    const token = cur.peek();
    if (token.type !== 'ident') {
      /* A bare value here is nearly always a parameter written positionally that
         is not positional — `dist ~4[1..10]` instead of `dist drive ~4[1..10]`.
         Dimensionless parameters carry no unit to identify them, so the grammar
         asks for the name; saying which name turns a dead end into a one-token fix. */
      const missing = sig.params.find((p) => p.positional !== true && args[p.name] === undefined);
      throw cur.error(
        token,
        'arg.unexpected',
        `unexpected ${describeToken(token)} in ${owner} — expected a parameter name, '>>' or '|'`,
        missing === undefined ? undefined : `every value here is named: write '${missing.name} <value>'`,
      );
    }
    const spec = sig.params.find((p) => p.name === token.text && p.positional !== true);
    if (spec === undefined) {
      const named = sig.params.filter((p) => p.positional !== true).map((p) => p.name);
      const guess = didYouMean(token.text, named);
      throw cur.error(
        token,
        'arg.unknown',
        `unknown parameter '${token.text}' for ${owner} — expected one of ${expectedList(named)}`,
        guess === undefined ? undefined : `did you mean '${guess}'?`,
      );
    }
    if (args[spec.name] !== undefined) {
      throw cur.error(token, 'arg.duplicate', `parameter '${spec.name}' of ${owner} is set twice`);
    }
    cur.next();
    args[spec.name] = parseArgValue(cur, spec, owner);
  }

  for (const spec of sig.params) {
    if (spec.required === true && args[spec.name] === undefined) {
      throw cur.error(
        cur.peek(),
        'arg.required',
        `${owner} requires parameter '${spec.name}' — ${spec.doc}`,
      );
    }
  }
  return args;
}

/* ------------------------------------------------------------------------- *
 * Header
 * ------------------------------------------------------------------------- */

interface Header {
  readonly name: string;
  readonly duration: NumberLiteral;
  readonly category: SoundCategory;
  readonly loop: boolean;
  readonly loc: Loc;
}

const DURATION_SPEC: ParamSpec = {
  name: 'duration',
  kind: 'time',
  required: true,
  doc: 'total duration contract of the sound',
};

function parseHeader(cur: Cursor): Header {
  const keyword = cur.next();
  if (keyword.type !== 'ident' || keyword.text !== 'sound') {
    const guess = keyword.type === 'ident' ? didYouMean(keyword.text, ['sound']) : undefined;
    throw cur.error(
      keyword,
      'header.keyword',
      `expected the header keyword 'sound', got ${describeToken(keyword)}`,
      guess === undefined ? 'a soundline starts with: sound "name" 35ms [category] [loop]' : `did you mean '${guess}'?`,
    );
  }

  const nameTok = cur.next();
  if (nameTok.type !== 'string') {
    throw cur.error(
      nameTok,
      'header.name',
      `expected a quoted sound name after 'sound', got ${describeToken(nameTok)}`,
      'e.g. sound "bubble pop" 35ms',
    );
  }

  const duration = parseLiteral(cur, DURATION_SPEC, 'the sound header');

  let category: SoundCategory = 'misc';
  let loop = false;
  let sawCategory = false;

  while (!cur.atEnd()) {
    const token = cur.peek();
    if (token.type !== 'ident') break;
    if (token.text === 'loop') {
      if (loop) throw cur.error(token, 'header.loop-duplicate', "the 'loop' flag is set twice");
      loop = true;
      cur.next();
      continue;
    }
    if ((SOUND_CATEGORIES as readonly string[]).includes(token.text)) {
      if (sawCategory) {
        throw cur.error(token, 'header.category-duplicate', `the sound already has a category '${category}'`);
      }
      category = token.text as SoundCategory;
      sawCategory = true;
      cur.next();
      continue;
    }
    const guess = didYouMean(token.text, [...SOUND_CATEGORIES, 'loop']);
    throw cur.error(
      token,
      'header.category',
      `unknown category '${token.text}' — expected one of ${expectedList(SOUND_CATEGORIES)}`,
      guess === undefined ? "categories drive the physical validator; omit it to get 'misc'" : `did you mean '${guess}'?`,
    );
  }

  if (!cur.atEnd()) {
    const token = cur.peek();
    throw cur.error(
      token,
      'header.trailing',
      `unexpected ${describeToken(token)} after the sound header`,
      'the header is: sound "name" <duration> [category] [loop]',
    );
  }

  return { name: nameTok.text, duration, category, loop, loc: keyword.loc };
}

/* ------------------------------------------------------------------------- *
 * Layers
 * ------------------------------------------------------------------------- */

function parseLayer(cur: Cursor, leading: readonly string[], trailing: string | undefined): LayerNode {
  const nameTok = cur.next();
  if (nameTok.type !== 'ident') {
    if (nameTok.type === 'colon') {
      throw cur.error(nameTok, 'layer.name', "expected a layer name before ':'", 'e.g. snap: noise white | gain 0.7 decay 18ms');
    }
    throw cur.error(
      nameTok,
      'layer.name',
      `expected a layer name, got ${describeToken(nameTok)}`,
      'every line after the header is "<name>: <primitive> ... | <envelope>"',
    );
  }
  const colon = cur.next();
  if (colon.type !== 'colon') {
    throw cur.error(
      colon,
      'layer.colon',
      `expected ':' after layer name '${nameTok.text}', got ${describeToken(colon)}`,
    );
  }

  const primTok = cur.next();
  if (primTok.type !== 'ident' || PRIMITIVES[primTok.text] === undefined) {
    const guess = primTok.type === 'ident' ? didYouMean(primTok.text, PRIMITIVE_NAMES) : undefined;
    throw cur.error(
      primTok,
      'primitive.unknown',
      `unknown primitive ${describeToken(primTok)} in layer '${nameTok.text}' — expected one of ${expectedList(PRIMITIVE_NAMES)}`,
      guess === undefined ? undefined : `did you mean '${guess}'?`,
    );
  }
  const primSig = PRIMITIVES[primTok.text] as Signature;
  const source: SourceNode = {
    kind: 'source',
    name: primTok.text,
    args: parseArgs(cur, primSig, `primitive '${primTok.text}'`),
    loc: primTok.loc,
  };

  const chain: EffectNode[] = [];
  while (cur.peek().type === 'chain') {
    cur.next();
    const effTok = cur.next();
    if (effTok.type !== 'ident' || EFFECTS[effTok.text] === undefined) {
      const guess = effTok.type === 'ident' ? didYouMean(effTok.text, EFFECT_NAMES) : undefined;
      throw cur.error(
        effTok,
        'effect.unknown',
        `unknown effect ${describeToken(effTok)} after '>>' — expected one of ${expectedList(EFFECT_NAMES)}`,
        guess === undefined ? undefined : `did you mean '${guess}'?`,
      );
    }
    const effSig = EFFECTS[effTok.text] as Signature;
    chain.push({
      kind: 'effect',
      name: effTok.text,
      args: parseArgs(cur, effSig, `effect '${effTok.text}'`),
      loc: effTok.loc,
    });
  }

  const pipe = cur.next();
  if (pipe.type !== 'pipe') {
    throw cur.error(
      pipe,
      'layer.envelope-missing',
      `layer '${nameTok.text}' has no envelope — expected '|' after the source chain, got ${describeToken(pipe)}`,
      'e.g. | gain 0.8 decay 30ms',
    );
  }
  const envelope: EnvelopeNode = {
    args: parseArgs(cur, ENVELOPE, 'the envelope'),
    loc: pipe.loc,
  };

  if (!cur.atEnd()) {
    const token = cur.peek();
    throw cur.error(token, 'layer.trailing', `unexpected ${describeToken(token)} after the envelope`);
  }

  return {
    name: nameTok.text,
    source,
    chain,
    envelope,
    leading,
    ...(trailing === undefined ? {} : { trailing }),
    loc: nameTok.loc,
  };
}

/* ------------------------------------------------------------------------- *
 * Program
 * ------------------------------------------------------------------------- */

/**
 * Parse a soundline document, collecting up to one error per line.
 *
 * Lexical errors abort immediately (a broken token stream cannot be split into
 * lines reliably); everything after that recovers line by line.
 */
export function parseWithDiagnostics(source: string): ParseResult {
  let tokens: readonly Token[];
  try {
    tokens = tokenize(source);
  } catch (error) {
    if (error instanceof SoundlineError) return { ast: null, errors: [error] };
    throw error;
  }

  const lines = groupLines(tokens);
  const errors: SoundlineError[] = [];
  const zeroLoc: Loc = { line: 1, column: 1, offset: 0, length: 0 };

  let header: Header | undefined;
  let headerTrailing: string | undefined;
  const fileLeading: string[] = [];
  let pending: string[] = [];
  const layers: LayerNode[] = [];
  const seen = new Set<string>();

  for (const logical of lines) {
    if (logical.tokens.length === 0) {
      // A comment-only line: attaches to whatever declaration comes next.
      if (logical.comment !== undefined) pending.push(logical.comment.text);
      continue;
    }
    const cur = new Cursor(logical.tokens, logical.line);
    const trailing = logical.comment?.text;

    if (header === undefined) {
      try {
        header = parseHeader(cur);
        fileLeading.push(...pending);
        headerTrailing = trailing;
      } catch (error) {
        if (!(error instanceof SoundlineError)) throw error;
        errors.push(error);
      }
      pending = [];
      continue;
    }

    try {
      const layer = parseLayer(cur, pending, trailing);
      if (seen.has(layer.name)) {
        errors.push(
          new SoundlineError({
            code: 'layer.duplicate',
            detail: `duplicate layer name '${layer.name}'`,
            loc: layer.loc,
            hint: 'layer names are how the validator and the diff address layers — make them unique',
          }),
        );
      } else {
        seen.add(layer.name);
        layers.push(layer);
      }
    } catch (error) {
      if (!(error instanceof SoundlineError)) throw error;
      errors.push(error);
    }
    pending = [];
  }

  if (header === undefined) {
    if (errors.length === 0) {
      errors.push(
        new SoundlineError({
          code: 'document.empty',
          detail: 'empty document — expected a sound header',
          loc: zeroLoc,
          hint: 'start with: sound "name" 35ms [category] [loop]',
        }),
      );
    }
    return { ast: null, errors };
  }

  if (layers.length === 0 && errors.length === 0) {
    errors.push(
      new SoundlineError({
        code: 'document.no-layers',
        detail: `sound "${header.name}" has no layers`,
        loc: header.loc,
        hint: 'add at least one layer, e.g. body: tone sine 480Hz | gain 0.9 decay 30ms',
      }),
    );
  }

  const ast: SoundAST = {
    name: header.name,
    duration: header.duration,
    category: header.category,
    loop: header.loop,
    layers,
    leading: fileLeading,
    ...(headerTrailing === undefined ? {} : { trailing: headerTrailing }),
    loc: header.loc,
  };
  return { ast, errors };
}

/**
 * Parse a soundline document, throwing on the first error.
 *
 * @throws {SoundlineError} with a `line L, col C: ...` message.
 */
export function parse(source: string): SoundAST {
  const { ast, errors } = parseWithDiagnostics(source);
  const first = errors[0];
  if (first !== undefined) throw first;
  if (ast === null) {
    throw new SoundlineError({
      code: 'document.empty',
      detail: 'empty document — expected a sound header',
      loc: { line: 1, column: 1, offset: 0, length: 0 },
    });
  }
  return ast;
}
