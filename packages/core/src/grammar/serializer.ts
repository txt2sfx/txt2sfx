/**
 * {@link SoundAST} -> canonical soundline text.
 *
 * "Canonical" means: two-space layer indent, arguments in signature order,
 * defaults omitted, `misc` category omitted, comments preserved. Parsing and
 * serializing is therefore a normalizing round-trip — `serialize(parse(src))`
 * equals `src` for any source already written in canonical form, and reduces
 * any other source to it. That property is what makes soundline diffable and
 * safe to store as the single source of truth in the recipe bank.
 *
 * @packageDocumentation
 */

import type {
  ArgValue,
  EffectNode,
  EnvelopeNode,
  LayerNode,
  NodeArgs,
  Signature,
  SoundAST,
  SourceNode,
} from '@txt2sfx/shared';
import { ENVELOPE, lookupSignature } from './signatures.js';
import { formatLiteral } from './units.js';

/** Indentation of a layer line. */
const INDENT = '  ';

/**
 * Parameters written glued to their value (`Q6`).
 *
 * Restricted to single-letter names: `Q6` is how filter resonance is written
 * everywhere in audio, while `gain0.9` would just be hard to read.
 */
const GLUED = /^[A-Z]$/;

function escapeName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatValue(value: ArgValue): string {
  switch (value.kind) {
    case 'enum':
      return value.value;
    case 'list':
      return value.values.join(':');
    case 'number': {
      let out = formatLiteral(value.head);
      for (const seg of value.ramp) {
        const curve = seg.curve === 'lin' ? 'lin ' : '';
        out += ` -> ${curve}${formatLiteral(seg.to)} in ${formatLiteral(seg.time)}`;
      }
      return out;
    }
  }
}

function formatArgs(args: NodeArgs, sig: Signature): string {
  const parts: string[] = [];
  for (const spec of sig.params) {
    const value = args[spec.name];
    if (value === undefined) continue;
    const text = formatValue(value);
    if (spec.positional === true) {
      parts.push(text);
    } else if (GLUED.test(spec.name)) {
      parts.push(`${spec.name}${text}`);
    } else {
      parts.push(`${spec.name} ${text}`);
    }
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

function signatureOf(name: string): Signature {
  const sig = lookupSignature(name);
  if (sig === undefined) throw new Error(`cannot serialize unknown node '${name}'`);
  return sig;
}

function formatSource(source: SourceNode): string {
  return `${source.name}${formatArgs(source.args, signatureOf(source.name))}`;
}

function formatEffect(effect: EffectNode): string {
  return `${effect.name}${formatArgs(effect.args, signatureOf(effect.name))}`;
}

function formatEnvelope(envelope: EnvelopeNode): string {
  return `|${formatArgs(envelope.args, ENVELOPE)}`;
}

/** Serialize one layer, without the trailing newline. */
export function serializeLayer(layer: LayerNode): string {
  const chain = layer.chain.map((effect) => ` >> ${formatEffect(effect)}`).join('');
  const trailing = layer.trailing === undefined ? '' : ` #${layer.trailing}`;
  return `${INDENT}${layer.name}: ${formatSource(layer.source)}${chain} ${formatEnvelope(layer.envelope)}${trailing}`;
}

/** Serialize an AST to canonical soundline text, ending with a newline. */
export function serialize(ast: SoundAST): string {
  const lines: string[] = [];
  for (const comment of ast.leading) lines.push(`#${comment}`);

  const category = ast.category === 'misc' ? '' : ` ${ast.category}`;
  const loop = ast.loop ? ' loop' : '';
  const trailing = ast.trailing === undefined ? '' : ` #${ast.trailing}`;
  lines.push(`sound "${escapeName(ast.name)}" ${formatLiteral(ast.duration)}${category}${loop}${trailing}`);

  for (const layer of ast.layers) {
    for (const comment of layer.leading) lines.push(`${INDENT}#${comment}`);
    lines.push(serializeLayer(layer));
  }
  return `${lines.join('\n')}\n`;
}
