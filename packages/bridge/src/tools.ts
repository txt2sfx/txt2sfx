/**
 * The twelve tools, and the dispatch that runs them.
 *
 * Two writing rules govern this file, both consequences of who reads it:
 *
 * 1. **The descriptions are the documentation.** The MCP client's model has
 *    never seen soundline, will not read `docs/`, and decides which tool to
 *    call from these strings alone — so each one says what the tool is *for*
 *    and what to do with the answer, not just what it returns. `sfx_contract`
 *    says to call it first, because nothing else will.
 * 2. **Results are prose a model can act on, never a bare JSON dump.** A dump
 *    makes the model infer which number is wrong and which direction to move
 *    it — the exact inferences `humanReadableDiff` and the validator hints
 *    exist to remove. Measurements are framed, hints are passed verbatim.
 *
 * A tool failure is `{ content, isError: true }` and *not* a protocol error:
 * "your soundline does not parse" is an answer the model must see and repair,
 * while a JSON-RPC error is plumbing many clients surface as a retry or a
 * crash. `runTool` enforces the distinction by catching everything a tool
 * throws.
 *
 * @packageDocumentation
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { SoundAST, SoundProfile } from '@txt2sfx/shared';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import {
  SoundlineError,
  codegen,
  declaredDurationMs,
  encodeWav,
  formatIssues,
  hasErrors,
  parse,
  serialize,
  validate,
  validateRender,
} from '@txt2sfx/core';
import { diffMarkdown, humanReadableDiff, profileMarkdown, soundDistance } from '@txt2sfx/analyzer';
import { llmsText } from '@txt2sfx/agent';
import { collectSlots, optimize } from '@txt2sfx/optimizer';
import type { ToolHub } from './hub.js';
import type { Log } from './log.js';
import { NEXT_DEFAULT_TIMEOUT_MS, NEXT_MAX_TIMEOUT_MS } from './protocol.js';
import type {
  AuditionResult,
  CompareResult,
  FitResult,
  NextResult,
  RenderResult,
} from './protocol.js';
import { resolveRenderer, type NativeRenderer } from './render.js';

/** Everything a tool may touch. Injected whole, so tests can fake any part. */
export interface ToolContext {
  readonly hub: ToolHub;
  readonly native: NativeRenderer;
  /** Recipe bank origin, e.g. `http://127.0.0.1:8787`. */
  readonly bankUrl: string;
  /** Where relative export paths land, and the default write boundary. */
  readonly cwd: string;
  /** Extra directories `sfx_export` may write into, from `--allow-write`. */
  readonly allowWrite: readonly string[];
  readonly log: Log;
  /** Injectable for tests; defaults to the global. */
  readonly fetch?: typeof fetch;
}

/** MCP tool-call result. `isError` marks a failure the *model* should repair. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** One tool: schema for the client, behaviour for the dispatch. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** A failure whose message was written to be read by the calling model. */
class ToolFailure extends Error {}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const failed = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/* --- argument plumbing ------------------------------------------------------ */

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolFailure(`the "${name}" argument is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  return typeof value === 'boolean' ? value : undefined;
}

/** Parse or die with the parser's own words — caret and all, because the
 * caller sent the source and can line the caret up against it. */
function parseOrExplain(soundline: string): SoundAST {
  try {
    return parse(soundline);
  } catch (error) {
    if (error instanceof SoundlineError) {
      throw new ToolFailure(
        `that soundline does not parse:\n\n${error.format(soundline)}\n\nFix that line and try again. Call sfx_contract for the grammar if you have not.`,
      );
    }
    throw error;
  }
}

/* --- shared formatting ------------------------------------------------------ */

/** The measured facts of a render, plus every hint the validators produced. */
function renderReport(
  ast: SoundAST,
  measured: {
    readonly peak: number;
    readonly clipped: boolean;
    readonly durationMs: number;
    readonly bytes: number;
    readonly withinBudget: boolean;
    readonly profile: SoundProfile;
  },
  renderedBy: string,
): string {
  const issues = [...validate(ast), ...validateRender({ peak: measured.peak })];
  const slots = collectSlots(ast);
  const lines = [
    `rendered "${ast.name}" (${renderedBy}): peak ${measured.peak.toFixed(3)}${
      measured.clipped ? ' — CLIPPED, lower a gain' : ''
    }, ${String(Math.round(measured.durationMs))} ms, exports to ${String(measured.bytes)} bytes (${
      measured.withinBudget ? 'within' : 'over'
    } the ${String(GLOBAL_LIMITS.maxExportBytes)}-byte budget — over is allowed and reported, never truncated)`,
    '',
    profileMarkdown('render', measured.profile),
    '',
    slots.length > 0
      ? `${String(slots.length)} ~slot(s) available — sfx_fit can search them against a reference.`
      : 'no ~slots — mark numbers you are unsure of as ~value[min..max] so sfx_fit has something to move.',
  ];
  if (issues.length > 0) {
    lines.push('', 'validator:', formatIssues(issues));
  }
  return lines.join('\n');
}

/** One sentence when nothing can render, naming which of the two to fix. */
async function noRendererSentence(ctx: ToolContext): Promise<string> {
  return `nothing can render: ${(await resolveRenderer(false, ctx.native)).why} — open the playground (http://localhost:5173) or install the optional native renderer (npm i node-web-audio-api).`;
}

/* --- the bank ---------------------------------------------------------------- */

async function bankFetch(ctx: ToolContext, path: string, init?: RequestInit): Promise<Response> {
  const fetchImpl = ctx.fetch ?? fetch;
  try {
    return await fetchImpl(`${ctx.bankUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new ToolFailure(
      `the recipe bank is not reachable at ${ctx.bankUrl} — start it with \`pnpm --filter @txt2sfx/server start\` or point --bank / TXT2SFX_BANK at a running one.`,
    );
  }
}

/* --- direction A helpers ------------------------------------------------------ */

/**
 * Render by whichever tier is available right now.
 *
 * The playground wins when connected — the number the agent is told and the
 * number on the human's screen then come from the same render and cannot
 * disagree.
 */
async function renderAnywhere(
  ctx: ToolContext,
  soundline: string,
  seed: number | undefined,
): Promise<{ measured: Parameters<typeof renderReport>[1]; renderedBy: string }> {
  const resolution = await resolveRenderer(await ctx.hub.playgroundConnected(), ctx.native);

  if (resolution.renderer === 'playground') {
    const result = (await ctx.hub.callPlayground('playground.render', {
      soundline,
      ...(seed === undefined ? {} : { seed }),
    })) as RenderResult;
    return { measured: result, renderedBy: 'in the playground tab' };
  }

  if (resolution.renderer === 'native') {
    const ast = parseOrExplain(soundline);
    const result = await ctx.native.render(ast, seed);
    return { measured: result, renderedBy: 'natively' };
  }

  throw new ToolFailure(await noRendererSentence(ctx));
}

/* --- the twelve ----------------------------------------------------------------- */

const sfxContract: ToolDefinition = {
  name: 'sfx_contract',
  description:
    'Call this first, before writing any soundline. Returns the complete contract for the soundline language: ' +
    'the grammar, every sound source and effect with its parameter table (units, ranges, defaults), the category ' +
    'table with the physical limits a validator enforces, and worked example recipes. soundline is a compact text ' +
    'format describing a sound effect; it compiles to a self-contained Web Audio JavaScript function of a few ' +
    'hundred bytes, and every other sfx_ tool consumes it. The document is generated from the parser\'s own ' +
    'tables, so it cannot disagree with what sfx_validate accepts. About 12 KB of text.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, ctx): Promise<ToolResult> {
    /* Prefer the bank's copy: it embeds real, validated few-shot examples, and
       it describes the grammar that bank will accept on publish. */
    try {
      const response = await bankFetch(ctx, '/api/llms.txt');
      if (response.ok) return ok(await response.text());
    } catch {
      /* fall through to the locally generated document */
    }
    return ok(
      `${llmsText([])}\n\n> note: no recipe bank was reachable, so the examples section above is empty. The grammar and parameter tables are complete regardless — they are generated from the same tables the parser uses.`,
    );
  },
};

const sfxValidate: ToolDefinition = {
  name: 'sfx_validate',
  description:
    'Parse and validate a soundline document without rendering it. Returns either a clean bill (category, declared ' +
    'duration, layers, and how many ~slots the optimizer could search) or every problem found: syntax errors carry ' +
    'line and column, invariant violations carry the rule id, what you wrote, what the rule demands, and a hint ' +
    'phrased as an instruction — apply the hint to the soundline and validate again. Never try to repair generated ' +
    'JavaScript; the soundline is the source of truth. Cheap and offline: use it after every edit, before spending a render.',
  inputSchema: {
    type: 'object',
    properties: {
      soundline: { type: 'string', description: 'The complete soundline document to check.' },
    },
    required: ['soundline'],
    additionalProperties: false,
  },
  run(args, _ctx): Promise<ToolResult> {
    const soundline = requireString(args, 'soundline');
    const ast = parseOrExplain(soundline);
    const issues = validate(ast);
    const slots = collectSlots(ast);
    const head = `"${ast.name}" parses: category ${ast.category}, ${String(declaredDurationMs(ast))} ms declared, ${String(ast.layers.length)} layer(s), ${String(slots.length)} ~slot(s).`;
    if (issues.length === 0) {
      return Promise.resolve(ok(`${head}\nNo validation issues. Render it with sfx_render to measure what the text cannot predict.`));
    }
    const verdict = hasErrors(issues)
      ? 'It breaks the invariants below — fix each hint and validate again:'
      : 'It validates with warnings — worth reading, not blocking:';
    const result = ok(`${head}\n${verdict}\n\n${formatIssues(issues)}`);
    if (hasErrors(issues)) result.isError = true;
    return Promise.resolve(result);
  },
};

const sfxRender: ToolDefinition = {
  name: 'sfx_render',
  description:
    'Render a soundline recipe and measure the result: peak amplitude and whether it clips, real duration, exported ' +
    'JavaScript size in bytes, and an acoustic profile (attack, dominant frequency, spectral centroid, flatness, ' +
    'loudness). These are measured facts the text cannot predict — layers do not peak together, and a filter can push ' +
    'a peak above its input — so render before you trust a recipe. Needs a renderer: a connected playground tab ' +
    '(preferred) or the optional native audio module. sfx_validate and sfx_contract work without one.',
  inputSchema: {
    type: 'object',
    properties: {
      soundline: { type: 'string', description: 'The complete soundline document to render.' },
      seed: { type: 'number', description: 'Noise seed for a reproducible render. Omit for the default.' },
    },
    required: ['soundline'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const soundline = requireString(args, 'soundline');
    const ast = parseOrExplain(soundline);
    const { measured, renderedBy } = await renderAnywhere(ctx, soundline, optionalNumber(args, 'seed'));
    return ok(renderReport(ast, measured, renderedBy));
  },
};

const sfxAudition: ToolDefinition = {
  name: 'sfx_audition',
  description:
    'Play a soundline recipe out loud in the connected playground tab, so the human at the machine actually hears ' +
    'it, and optionally select it there. Returns the measured duration, peak and clipping. This is the one tool whose ' +
    'entire point is a human ear — use it when a sound is worth a listen, not after every edit. Requires a playground ' +
    'tab connected to the bridge.',
  inputSchema: {
    type: 'object',
    properties: {
      soundline: { type: 'string', description: 'The complete soundline document to play.' },
      seed: { type: 'number', description: 'Noise seed. Omit for the default.' },
      loop: { type: 'boolean', description: 'Keep it playing on a loop (for cycle-category textures).' },
      select: { type: 'boolean', description: 'Also select it in the playground UI.' },
    },
    required: ['soundline'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const soundline = requireString(args, 'soundline');
    parseOrExplain(soundline); // fail here with a good message, not in the tab
    const seed = optionalNumber(args, 'seed');
    const loop = optionalBoolean(args, 'loop');
    const select = optionalBoolean(args, 'select');
    const result = (await ctx.hub.callPlayground('playground.audition', {
      soundline,
      ...(seed === undefined ? {} : { seed }),
      ...(loop === undefined ? {} : { loop }),
      ...(select === undefined ? {} : { select }),
    })) as AuditionResult;
    return ok(
      `played in the tab: ${String(Math.round(result.durationMs))} ms, peak ${result.peak.toFixed(3)}${
        result.clipped ? ' — CLIPPED' : ''
      }. The human heard it.`,
    );
  },
};

const sfxCompare: ToolDefinition = {
  name: 'sfx_compare',
  description:
    'Compare a rendered recipe against a reference sound: a metrics table for both, a distance (0 is identical; ' +
    'roughly below 0.15 is a close match), and directives — concrete instructions like "raise bp frequency in layer ' +
    "'snap'\" — ordered worst first. Apply the directives to the soundline, or mark the numbers they name as ~slots " +
    'and run sfx_fit. By default this compares against the reference loaded in the playground\'s Compare panel; pass ' +
    '`reference` (another complete soundline document) to compare two recipes without a tab.',
  inputSchema: {
    type: 'object',
    properties: {
      soundline: {
        type: 'string',
        description: 'The candidate recipe. When omitted and a tab is connected, the tab compares its current sound.',
      },
      reference: {
        type: 'string',
        description:
          'A complete soundline document to render as the comparison target. Omit to use the reference loaded in the playground.',
      },
      seed: { type: 'number', description: 'Noise seed. Omit for the default.' },
    },
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const soundline = optionalString(args, 'soundline');
    const reference = optionalString(args, 'reference');
    const seed = optionalNumber(args, 'seed');

    if (reference === undefined) {
      /* The tab holds the reference (a recording we cannot pull over the wire),
         so the comparison must happen where the reference is. */
      let result: CompareResult;
      try {
        result = (await ctx.hub.callPlayground('playground.compare', {
          ...(soundline === undefined ? {} : { soundline }),
          ...(seed === undefined ? {} : { seed }),
        })) as CompareResult;
      } catch (error) {
        throw new ToolFailure(
          `${error instanceof Error ? error.message : String(error)} To compare without a tab, pass \`reference\` (a second soundline document).`,
        );
      }
      return ok(
        `distance to "${result.reference}": ${result.distance.toFixed(3)}\n\n${result.metrics}\n\nwhat to change, worst first:\n${diffMarkdown(result.directives)}`,
      );
    }

    if (soundline === undefined) {
      throw new ToolFailure('pass `soundline` when passing `reference` — there is no tab-side current sound in this mode.');
    }
    const candidateAst = parseOrExplain(soundline);
    const referenceAst = parseOrExplain(reference);
    if (!(await ctx.native.available())) {
      throw new ToolFailure(
        `comparing two recipes renders both, and ${await ctx.native.reason()} — install it (npm i node-web-audio-api), or load a reference in the playground and omit \`reference\`.`,
      );
    }
    const candidate = await ctx.native.render(candidateAst, seed);
    const target = await ctx.native.render(referenceAst, seed);
    const distance = soundDistance(
      { signal: { samples: candidate.samples, sampleRate: candidate.sampleRate }, profile: candidate.profile },
      { signal: { samples: target.samples, sampleRate: target.sampleRate }, profile: target.profile },
    );
    const directives = humanReadableDiff(candidate.profile, target.profile, candidateAst);
    return ok(
      `distance to "${referenceAst.name}": ${distance.toFixed(3)}\n\n${profileMarkdown('candidate', candidate.profile)}\n\n${profileMarkdown('reference', target.profile)}\n\nwhat to change, worst first:\n${diffMarkdown(directives)}`,
    );
  },
};

const sfxFit: ToolDefinition = {
  name: 'sfx_fit',
  description:
    'Run a differential-evolution optimizer over every ~value[min..max] slot in the recipe, minimizing the distance ' +
    'to a reference sound. Structure never changes — only the numbers you marked with ~. Returns the improved recipe ' +
    'with the initial and final distance. This is the intended division of labour: you design the layers and mark ' +
    'every number you are unsure of as a ~slot; the search finds the values. Uses the reference loaded in the ' +
    'playground by default; pass `reference` (another soundline document) to fit against its render without a tab. ' +
    'Can run for minutes — it is a population of renders per generation.',
  inputSchema: {
    type: 'object',
    properties: {
      soundline: {
        type: 'string',
        description: 'The recipe to improve. Its ~slots are the whole search space; without any, there is nothing to fit.',
      },
      reference: {
        type: 'string',
        description: 'A soundline document whose render is the target. Omit to use the reference loaded in the playground.',
      },
      generations: { type: 'number', description: 'Search budget. Default 30.' },
      seed: { type: 'number', description: 'Noise seed. Omit for the default.' },
    },
    required: ['soundline'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const soundline = requireString(args, 'soundline');
    const reference = optionalString(args, 'reference');
    const generations = optionalNumber(args, 'generations');
    const seed = optionalNumber(args, 'seed');
    const ast = parseOrExplain(soundline);

    if (collectSlots(ast).length === 0) {
      throw new ToolFailure(
        'the recipe has no ~slots, so there is nothing to fit — mark the numbers you are unsure of as ~value[min..max] and try again.',
      );
    }

    if (reference === undefined) {
      let result: FitResult;
      try {
        result = (await ctx.hub.callPlayground('playground.fit', {
          soundline,
          ...(generations === undefined ? {} : { generations }),
          ...(seed === undefined ? {} : { seed }),
        })) as FitResult;
      } catch (error) {
        throw new ToolFailure(
          `${error instanceof Error ? error.message : String(error)} To fit without a tab, pass \`reference\` (a soundline document to match).`,
        );
      }
      return ok(
        `fit finished (${result.stopped}): distance ${result.initialDistance.toFixed(3)} -> ${result.distance.toFixed(3)}\n\n\`\`\`\n${result.soundline}\`\`\``,
      );
    }

    if (!(await ctx.native.available())) {
      throw new ToolFailure(
        `fitting against a reference renders hundreds of candidates, and ${await ctx.native.reason()} — install it (npm i node-web-audio-api), or load the reference in the playground and omit \`reference\`.`,
      );
    }
    const referenceAst = parseOrExplain(reference);
    const target = await ctx.native.render(referenceAst, seed);
    const result = await optimize({
      source: soundline,
      target: {
        profile: target.profile,
        signal: { samples: target.samples, sampleRate: target.sampleRate },
      },
      render: async (candidate) => {
        const rendered = await ctx.native.render(candidate, seed);
        return { samples: rendered.samples, sampleRate: rendered.sampleRate };
      },
      populationSize: 16,
      generations: generations ?? 30,
      /* Held to the recipe as written, like the playground's fit: unanchored,
         the search reliably trades the designed sound for a stranger that
         scores better — see AGENT_LOOP.md. */
      anchor: 0.25,
      initialSpread: 0.25,
      ...(seed === undefined ? {} : { seed }),
    });
    return ok(
      `fit finished (${result.de.stopped}): distance ${result.initialDistance.toFixed(3)} -> ${result.distance.toFixed(3)}\n\n\`\`\`\n${result.source}\`\`\``,
    );
  },
};

const sfxExport: ToolDefinition = {
  name: 'sfx_export',
  description:
    'Write a recipe to a file. Format `js`: the compiled, self-contained Web Audio function (typically 300–1700 ' +
    'bytes, zero dependencies — ship it and call it with an AudioContext). Format `wav`: rendered audio, 16-bit ' +
    '(needs the native renderer). Format `soundline`: the canonical text form, good for versioning. Relative paths ' +
    'resolve against the bridge\'s working directory; writes outside it are refused unless the bridge was started ' +
    'with --allow-write <dir>.',
  inputSchema: {
    type: 'object',
    properties: {
      soundline: { type: 'string', description: 'The complete soundline document to export.' },
      path: { type: 'string', description: 'Where to write. Relative to the bridge\'s working directory.' },
      format: { type: 'string', enum: ['js', 'wav', 'soundline'], description: 'What to write.' },
      seed: { type: 'number', description: 'Noise seed for the wav render. Omit for the default.' },
    },
    required: ['soundline', 'path', 'format'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const soundline = requireString(args, 'soundline');
    const givenPath = requireString(args, 'path');
    const format = requireString(args, 'format');
    if (format !== 'js' && format !== 'wav' && format !== 'soundline') {
      throw new ToolFailure('format must be one of: js, wav, soundline');
    }
    const ast = parseOrExplain(soundline);

    const target = resolve(ctx.cwd, givenPath);
    const roots = [ctx.cwd, ...ctx.allowWrite].map((root) => resolve(root));
    /* Windows paths compare case-insensitively; a boundary check that does not
       know that is a boundary that `C:\` versus `c:\` walks straight through. */
    const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
    const within = roots.some((root) => fold(target) === fold(root) || fold(target).startsWith(fold(root + sep)));
    if (!within) {
      throw new ToolFailure(
        `refusing to write outside the working directory: ${target}. Use a relative path, or start the bridge with --allow-write <dir> to permit that location.`,
      );
    }

    let bytes: Uint8Array;
    if (format === 'js') {
      bytes = new TextEncoder().encode(`${codegen(ast).code}\n`);
    } else if (format === 'soundline') {
      bytes = new TextEncoder().encode(serialize(ast));
    } else {
      if (!(await ctx.native.available())) {
        throw new ToolFailure(
          `a wav needs samples, and ${await ctx.native.reason()} — install it (npm i node-web-audio-api), or export js/soundline, which need no renderer.`,
        );
      }
      const rendered = await ctx.native.render(ast, optionalNumber(args, 'seed'));
      /* `encodeWav` speaks AudioBuffer, but the four members it reads are all a
         plain object can carry — cheaper than keeping the native buffer alive
         past its context just to satisfy a nominal type. */
      const shim = {
        numberOfChannels: 1,
        length: rendered.samples.length,
        sampleRate: rendered.sampleRate,
        duration: rendered.samples.length / rendered.sampleRate,
        getChannelData: () => rendered.samples,
      } as unknown as AudioBuffer;
      bytes = encodeWav(shim);
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return ok(`wrote ${String(bytes.length)} bytes of ${format} to ${target}`);
  },
};

const sfxOpen: ToolDefinition = {
  name: 'sfx_open',
  description:
    'Load a recipe into the playground\'s Studio editor so the human can take over: hear it, drag the ~slot sliders, ' +
    'compare and export. Use it to hand off a finished or near-finished sound — it is the "over to you" gesture. ' +
    'Requires a playground tab connected to the bridge.',
  inputSchema: {
    type: 'object',
    properties: {
      soundline: { type: 'string', description: 'The complete soundline document to load.' },
      name: { type: 'string', description: 'Name to load it under. Defaults to the name in the recipe header.' },
      prompt: { type: 'string', description: 'The request this recipe answers, shown alongside it.' },
    },
    required: ['soundline'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const soundline = requireString(args, 'soundline');
    const ast = parseOrExplain(soundline);
    const name = optionalString(args, 'name') ?? ast.name;
    const prompt = optionalString(args, 'prompt');
    const result = (await ctx.hub.callPlayground('playground.open', {
      soundline,
      name,
      ...(prompt === undefined ? {} : { prompt }),
    })) as { name: string };
    return ok(`loaded into the Studio as "${result.name}". The human has it now.`);
  },
};

const sfxBankSearch: ToolDefinition = {
  name: 'sfx_bank_search',
  description:
    'Full-text search over the recipe bank of solved sounds. Returns matches with the prompt each recipe answers and ' +
    'its complete soundline — the best way to see how a similar sound was structured before writing your own. Copy ' +
    'structure, not numbers: a stored recipe may predate a validator rule, so trust sfx_validate over any example.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms, e.g. "coin pickup arcade".' },
      category: {
        type: 'string',
        description: 'Restrict to one category (pop, ui, laser, impact, explosion, pickup, foley, cycle, misc).',
      },
      limit: { type: 'number', description: 'Max results. Default 5.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const query = requireString(args, 'query');
    const category = optionalString(args, 'category');
    const limit = optionalNumber(args, 'limit') ?? 5;
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (category !== undefined) params.set('category', category);
    const response = await bankFetch(ctx, `/api/recipes?${params.toString()}`);
    const body = (await response.json()) as {
      recipes?: { name: string; prompt: string; category: string; durationMs: number; rating: number; soundline: string }[];
      message?: string;
    };
    if (!response.ok) {
      throw new ToolFailure(`the bank refused the search: ${body.message ?? `status ${String(response.status)}`}`);
    }
    const recipes = body.recipes ?? [];
    if (recipes.length === 0) {
      return ok(`nothing in the bank matches "${query}". Write the recipe from the contract — and publish it with sfx_bank_publish once it is good, so the next search finds it.`);
    }
    const blocks = recipes.map(
      (recipe) =>
        `**${recipe.name}** (${recipe.category}, ${String(recipe.durationMs)} ms, rating ${String(recipe.rating)}) — asked for as "${recipe.prompt}"\n\`\`\`\n${recipe.soundline.endsWith('\n') ? recipe.soundline : `${recipe.soundline}\n`}\`\`\``,
    );
    return ok(`${String(recipes.length)} match(es) for "${query}":\n\n${blocks.join('\n\n')}`);
  },
};

const sfxBankPublish: ToolDefinition = {
  name: 'sfx_bank_publish',
  description:
    'Store a solved recipe in the bank so future searches — yours and other agents\' — find it. The bank validates ' +
    'before writing and rejects broken invariants with hints; this tool renders the recipe to measure its acoustic ' +
    'profile for you, so it needs a renderer. Phrase `prompt` the way a person would ask for the sound ("coin pickup ' +
    'for a platformer"), not as a description of the recipe — retrieval ranks against it. Publishing twice with ' +
    'identical content is safe.',
  inputSchema: {
    type: 'object',
    properties: {
      soundline: { type: 'string', description: 'The complete, validated soundline document to store.' },
      prompt: { type: 'string', description: 'The request this recipe answers, phrased as a person would type it.' },
      name: { type: 'string', description: 'Name to store it under. Defaults to the name in the recipe header.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Search tags, e.g. ["coin", "arcade"].' },
    },
    required: ['soundline', 'prompt'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const soundline = requireString(args, 'soundline');
    const prompt = requireString(args, 'prompt');
    const ast = parseOrExplain(soundline);
    const name = optionalString(args, 'name') ?? ast.name;
    const tags = Array.isArray(args['tags']) ? args['tags'].filter((tag): tag is string => typeof tag === 'string') : [];

    const { measured } = await renderAnywhere(ctx, soundline, undefined);
    const response = await bankFetch(ctx, '/api/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, prompt, soundline, profile: measured.profile, tags }),
    });
    const body = (await response.json()) as {
      recipe?: { id: number };
      created?: boolean;
      message?: string;
      issues?: Parameters<typeof formatIssues>[0];
      warnings?: Parameters<typeof formatIssues>[0];
    };
    if (response.status === 422 && body.issues !== undefined) {
      throw new ToolFailure(`the bank refused it — fix these and publish again:\n\n${formatIssues(body.issues)}`);
    }
    if (!response.ok) {
      throw new ToolFailure(`the bank refused it: ${body.message ?? `status ${String(response.status)}`}`);
    }
    const warnings =
      body.warnings !== undefined && body.warnings.length > 0 ? `\nwarnings:\n${formatIssues(body.warnings)}` : '';
    return ok(
      body.created === false
        ? `already in the bank as id ${String(body.recipe?.id ?? '?')} — identical content, nothing stored twice.${warnings}`
        : `stored as id ${String(body.recipe?.id ?? '?')}.${warnings}`,
    );
  },
};

const sfxNextRequest: ToolDefinition = {
  name: 'sfx_next_request',
  description:
    'Long-poll for a generation request from the playground. When a human picks the "agent" provider there and ' +
    'presses Generate, their request — the full soundline contract as a system prompt, the conversation so far — ' +
    'parks at the bridge until you collect it here. Returns the request, or says none is waiting after the timeout, ' +
    'which is normal: poll again, or stop when your own task is done. Answer with sfx_answer. If your MCP client ' +
    'supports sampling, the bridge answers these itself and this tool will find nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      timeout: {
        type: 'number',
        description: 'How long to wait for a request, in milliseconds. Default 25000, capped at 120000.',
      },
    },
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const raw = optionalNumber(args, 'timeout') ?? NEXT_DEFAULT_TIMEOUT_MS;
    const timeout = Math.min(Math.max(raw, 0), NEXT_MAX_TIMEOUT_MS);
    const result: NextResult = await ctx.hub.nextRequest(timeout);
    if ('none' in result) {
      return ok(
        'no generation request is waiting. In the playground, the human picks the "agent" provider and presses Generate; poll again when you expect one.',
      );
    }
    const { request } = result;
    const conversation = request.messages
      .map((message) => `--- ${message.role} ---\n${message.content}`)
      .join('\n\n');
    return ok(
      `generation request "${request.id}" (turn ${String(request.turn)}) is waiting. Reply with sfx_answer: id "${request.id}", text = one fenced code block containing the complete soundline document, nothing else.\n\n=== system prompt (${String(request.systemBytes)} bytes) ===\n${request.system}\n\n=== conversation ===\n${conversation}`,
    );
  },
};

const sfxAnswer: ToolDefinition = {
  name: 'sfx_answer',
  description:
    'Answer (or fail) a generation request collected with sfx_next_request. Pass the request\'s id and your reply in ' +
    '`text`: exactly one fenced code block containing the complete soundline document, exactly as the request\'s ' +
    'system prompt instructs. Everything downstream — extraction, validation, render, optimizer, repair — runs in the ' +
    'playground as if a hosted model had replied; a follow-up request may park if your recipe needs repair. Pass ' +
    '`error` instead of `text` to fail the request with one sentence (the correct reply to a request procedural ' +
    'synthesis cannot honour, like a human voice).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id from sfx_next_request.' },
      text: { type: 'string', description: 'Your reply: one fenced code block with the complete soundline document.' },
      error: { type: 'string', description: 'Fail the request with this message instead of answering it.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const id = requireString(args, 'id');
    const text = optionalString(args, 'text');
    const errorMessage = optionalString(args, 'error');
    if ((text === undefined) === (errorMessage === undefined)) {
      throw new ToolFailure('pass exactly one of `text` (to answer) or `error` (to fail).');
    }
    const delivered =
      text !== undefined ? await ctx.hub.answer(id, text) : await ctx.hub.fail(id, errorMessage ?? '');
    if (!delivered) {
      throw new ToolFailure(
        `request "${id}" is not waiting — it was already answered, or the playground went away. Poll sfx_next_request for the current one.`,
      );
    }
    return ok(
      text !== undefined
        ? `answered "${id}" — the playground is extracting, validating and rendering it now. Poll sfx_next_request in case it comes back for repair.`
        : `failed "${id}" — the playground will show your message to the human.`,
    );
  },
};

/** The twelve, in the order the spec lists them. */
export const TOOLS: readonly ToolDefinition[] = [
  sfxContract,
  sfxValidate,
  sfxRender,
  sfxAudition,
  sfxCompare,
  sfxFit,
  sfxExport,
  sfxOpen,
  sfxBankSearch,
  sfxBankPublish,
  sfxNextRequest,
  sfxAnswer,
];

/** Names only, for `/health` and `tools/list`. */
export const TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.name);

/**
 * Run one tool. Anything thrown becomes `{ isError: true }` with the message
 * as the content — a failing tool is an answer for the model, never a
 * JSON-RPC error (see the module note).
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return failed(`no tool named "${name}" — the tools are: ${TOOL_NAMES.join(', ')}`);
  }
  try {
    return await tool.run(args, ctx);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}
