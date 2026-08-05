/**
 * The loop: prompt → soundline → validate → render → fit numbers → repeat.
 *
 * ## What the model is and is not asked to do
 *
 * The model designs structure. Everything that can be checked deterministically is
 * checked deterministically, and the model only hears about a failure it can act
 * on. In order:
 *
 * 1. **Parse.** A document that does not parse is sent back with the parser's own
 *    `line L, col C: ... (hint)` message. Nothing else is reported, because an
 *    unparseable document has no invariants to check.
 * 2. **Validate.** Physical invariants from the category contract. The validator's
 *    `hint` fields are already written as instructions; they go back verbatim.
 * 3. **Render.** Peak and near-silence cannot be derived from the text (layers do
 *    not peak together, a high-pass can lift the peak above its input), so they are
 *    measured and reported separately.
 * 4. **Fit the numbers.** With a target, differential evolution moves every `~`
 *    slot. This is where distance to the target is decided, and the model is not
 *    involved.
 *
 * ## The hard rule
 *
 * The model is asked for a structural change **only when the optimizer is stuck** —
 * `de.stopped === 'stalled'`, meaning the best fitness did not move for
 * `stallGenerations` generations and is still above the threshold. When the search
 * merely ran out of generations while still improving, the loop stops and reports
 * the distance rather than asking for a rewrite: the numbers were getting better,
 * and a new topology would throw away everything the search had found. That
 * asymmetry is why `stallGenerations` was calibrated the way it was (see `de.ts`).
 *
 * ## Without a target
 *
 * The common case in the playground is a prompt and no reference sound. There is
 * then no distance to minimize, and a recipe is accepted as soon as it parses,
 * validates and renders to something audible. That is the honest ceiling for
 * "make me a laser": correctness is checkable, resemblance is not.
 *
 * @packageDocumentation
 */

import type { SoundAST, ValidationIssue } from '@txt2sfx/shared';
import { SoundlineError, hasErrors, parse, validate, validateRender } from '@txt2sfx/core';
import { extractProfile, humanReadableDiff, type Signal } from '@txt2sfx/analyzer';
import { optimize, type RenderFn, type Target } from '@txt2sfx/optimizer';
import type { LLMProvider, Message } from './provider.js';
import type { RecipeSource } from './bank.js';
import { selectFewShot, type FewShotExample } from './fewshot.js';
import {
  extractSoundline,
  initialMessage,
  repairMessage,
  systemPrompt,
  type Failure,
} from './prompts.js';

/**
 * How a run ended.
 *
 * - `accepted` — a recipe passed everything that was checkable.
 * - `refused` — the model declined the request, as the contract tells it to for
 *   voices and realistic animals. Its sentence is in `message`.
 * - `no-soundline` / `parse-error` / `invalid` / `render` — the last attempt failed
 *   that stage and the iteration budget ran out.
 * - `distance` — valid and audible, but further from the target than asked, with
 *   the optimizer still improving when its budget ended.
 */
export type Outcome =
  | 'accepted'
  | 'refused'
  | 'no-soundline'
  | 'parse-error'
  | 'invalid'
  | 'render'
  | 'distance';

/** One trip through the model. */
export interface Attempt {
  /** 1-based. */
  readonly iteration: number;
  /** The model's full reply, kept for debugging and for the bench transcript. */
  readonly reply: string;
  /** What was extracted from it, if anything. */
  readonly soundline?: string;
  /** Everything the validator said, warnings included. */
  readonly issues: readonly ValidationIssue[];
  /** Distance to the target after fitting, when there was a target. */
  readonly distance?: number;
  readonly outcome: Outcome;
  /** What was sent back to the model. Absent on the attempt that ended the run. */
  readonly feedback?: string;
}

/** Progress, for a UI that wants to show the loop working rather than a spinner. */
export type AgentEvent =
  | { readonly type: 'request'; readonly iteration: number }
  | { readonly type: 'reply'; readonly iteration: number; readonly text: string }
  | {
      readonly type: 'validated';
      readonly iteration: number;
      readonly soundline: string;
      readonly issues: readonly ValidationIssue[];
    }
  | { readonly type: 'rendered'; readonly iteration: number; readonly peak: number }
  | {
      readonly type: 'optimized';
      readonly iteration: number;
      readonly distance: number;
      readonly initialDistance: number;
      readonly stopped: 'target' | 'stalled' | 'budget';
    }
  | { readonly type: 'feedback'; readonly iteration: number; readonly message: string }
  | { readonly type: 'done'; readonly outcome: Outcome; readonly accepted: boolean };

/** Options of {@link generateSound}. */
export interface GenerateOptions {
  readonly prompt: string;
  readonly provider: LLMProvider;
  /**
   * How a candidate becomes audio. Injected, exactly as the optimizer takes it —
   * this package owns no audio stack either.
   *
   * Omit it and the loop stops after text validation: no peak check, no silence
   * check, no fitting. Legitimate for a caller with no audio context, and worth
   * knowing about, because those are the two failure classes the text cannot see.
   */
  readonly render?: RenderFn;
  /** Where few-shot examples come from. Without one the prompt carries none. */
  readonly bank?: RecipeSource;
  /** How many examples to retrieve. Default 3. */
  readonly examples?: number;
  /** Override the generated contract document — see `SystemPromptOptions`. */
  readonly contract?: string;
  /** The sound being matched. Without it there is nothing to optimize against. */
  readonly target?: Target;
  /** Trips through the model, including the first. Default 4. */
  readonly maxIterations?: number;
  /**
   * Distance that counts as a match. Default 0.2.
   *
   * Calibrated against the measured matrix in the plan: distinguishable reference
   * sounds sit between 0.36 and 0.60, and a recipe recovered from scrambled slots
   * lands below 0.05. Anything under 0.2 is closer to the target than any two
   * different sounds in the reference set are to each other.
   */
  readonly targetDistance?: number;
  /** Passed straight to the optimizer. */
  readonly optimizer?: {
    readonly generations?: number;
    readonly populationSize?: number;
    readonly seed?: number;
    readonly stallGenerations?: number;
  };
  readonly onEvent?: (event: AgentEvent) => void;
  readonly signal?: AbortSignal;
}

/** What a run produced. */
export interface GenerateResult {
  readonly accepted: boolean;
  readonly outcome: Outcome;
  /** The best recipe reached — empty only when no attempt produced one. */
  readonly soundline: string;
  readonly ast?: SoundAST;
  /** Validation of the returned recipe. Warnings can survive acceptance. */
  readonly issues: readonly ValidationIssue[];
  readonly distance?: number;
  /** Distance before fitting, for the improvement it represents. */
  readonly initialDistance?: number;
  readonly attempts: readonly Attempt[];
  /** The examples the prompt actually carried. */
  readonly examples: readonly FewShotExample[];
  /** True when retrieval matched nothing and the examples are shape-only. */
  readonly fallbackExamples: boolean;
  /** The model's sentence, when `outcome` is `refused`. */
  readonly message?: string;
}

const DEFAULT_MAX_ITERATIONS = 4;
const DEFAULT_TARGET_DISTANCE = 0.2;
const DEFAULT_EXAMPLES = 3;

/** Largest absolute sample — the one render fact the validator needs. */
function peakOf(signal: Signal): number {
  let peak = 0;
  for (let i = 0; i < signal.samples.length; i++) {
    const abs = Math.abs(signal.samples[i] ?? 0);
    if (abs > peak) peak = abs;
  }
  return peak;
}

/**
 * A reply with no code in it at all is an answer, not a formatting mistake.
 *
 * The contract document tells the model to decline a request procedural synthesis
 * cannot serve — a human voice, a believable animal — with one sentence instead of
 * a recipe. Sending "reply with a fenced block" back to that sentence would produce
 * exactly the disappointing sound the instruction exists to prevent. A reply that
 * *does* contain a fence but no recipe is a different thing, and gets repaired.
 */
function looksLikeRefusal(reply: string): boolean {
  return !reply.includes('```');
}

/**
 * Generate a sound from a prompt.
 *
 * @example
 * ```ts
 * const result = await generateSound({
 *   prompt: 'coin pickup sound for a platformer',
 *   provider: geminiProvider({ apiKey }),
 *   render: renderSignal,
 *   bank: httpBank('http://127.0.0.1:8787'),
 * });
 * if (result.accepted) console.log(result.soundline);
 * ```
 */
export async function generateSound(options: GenerateOptions): Promise<GenerateResult> {
  const maxIterations = Math.max(1, options.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const targetDistance = options.targetDistance ?? DEFAULT_TARGET_DISTANCE;
  const emit = options.onEvent ?? ((): void => {});

  const retrieved =
    options.bank === undefined
      ? { recipes: [], fallback: false }
      : await options.bank.retrieve(options.prompt, options.examples ?? DEFAULT_EXAMPLES);
  const selection = selectFewShot(retrieved.recipes, options.examples ?? DEFAULT_EXAMPLES);

  const system = systemPrompt({
    examples: selection.examples,
    ...(options.contract === undefined ? {} : { contract: options.contract }),
  });

  const messages: Message[] = [
    {
      role: 'user',
      content: initialMessage(options.prompt, {
        ...(options.target === undefined ? {} : { target: options.target.profile }),
      }),
    },
  ];

  const attempts: Attempt[] = [];

  /** Everything but the per-run verdict, so each `return` says only what differs. */
  const base = {
    attempts,
    examples: selection.examples,
    fallbackExamples: retrieved.fallback,
  };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    emit({ type: 'request', iteration });
    const reply = await options.provider.complete({
      system,
      /* A copy, not the live array. A request is a value: a provider that queues,
         retries or records it must see the conversation as it was at the call, not
         as the loop later grew it. */
      messages: [...messages],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    emit({ type: 'reply', iteration, text: reply });
    messages.push({ role: 'assistant', content: reply });

    /** Record the attempt, push the feedback, and let the loop continue. */
    const reject = (outcome: Outcome, failure: Failure, soundline?: string, issues?: readonly ValidationIssue[]): void => {
      const feedback = repairMessage(failure);
      attempts.push({
        iteration,
        reply,
        ...(soundline === undefined ? {} : { soundline }),
        issues: issues ?? [],
        outcome,
        feedback,
      });
      messages.push({ role: 'user', content: feedback });
      emit({ type: 'feedback', iteration, message: feedback });
    };

    const soundline = extractSoundline(reply);

    if (soundline === undefined) {
      if (looksLikeRefusal(reply)) {
        attempts.push({ iteration, reply, issues: [], outcome: 'refused' });
        emit({ type: 'done', outcome: 'refused', accepted: false });
        return {
          ...base,
          accepted: false,
          outcome: 'refused',
          soundline: '',
          issues: [],
          message: reply.trim(),
        };
      }
      reject('no-soundline', { kind: 'no-soundline' });
      continue;
    }

    let ast: SoundAST;
    try {
      ast = parse(soundline);
    } catch (error) {
      const detail = error instanceof SoundlineError ? error.message : String(error);
      reject('parse-error', { kind: 'parse-error', detail }, soundline);
      continue;
    }

    const issues = validate(ast);
    if (hasErrors(issues)) {
      reject('invalid', { kind: 'invalid', issues }, soundline, issues);
      continue;
    }

    /* Nothing below this line can run without audio. A caller with no renderer
       gets the text-checked recipe, which is all it asked for. */
    if (options.render === undefined) {
      emit({ type: 'validated', iteration, soundline, issues });
      attempts.push({ iteration, reply, soundline, issues, outcome: 'accepted' });
      emit({ type: 'done', outcome: 'accepted', accepted: true });
      return { ...base, accepted: true, outcome: 'accepted', soundline, ast, issues };
    }

    const signal = await options.render(ast);
    const peak = peakOf(signal);
    emit({ type: 'rendered', iteration, peak });

    const renderIssues = validateRender({ peak });
    if (hasErrors(renderIssues)) {
      reject('render', { kind: 'render', issues: renderIssues }, soundline, [...issues, ...renderIssues]);
      continue;
    }

    const allIssues = [...issues, ...renderIssues];
    emit({ type: 'validated', iteration, soundline, issues: allIssues });

    if (options.target === undefined) {
      attempts.push({ iteration, reply, soundline, issues: allIssues, outcome: 'accepted' });
      emit({ type: 'done', outcome: 'accepted', accepted: true });
      return { ...base, accepted: true, outcome: 'accepted', soundline, ast, issues: allIssues };
    }

    /* With a target, the numbers are the optimizer's business. Note the recipe
       that comes back is the one that was measured, slot values and rounding
       included — the optimizer searches in the space of writable recipes. */
    const fitted = await optimize({
      source: soundline,
      target: options.target,
      render: options.render,
      targetFitness: targetDistance,
      ...(options.optimizer?.generations === undefined ? {} : { generations: options.optimizer.generations }),
      ...(options.optimizer?.populationSize === undefined
        ? {}
        : { populationSize: options.optimizer.populationSize }),
      ...(options.optimizer?.seed === undefined ? {} : { seed: options.optimizer.seed }),
      ...(options.optimizer?.stallGenerations === undefined
        ? {}
        : { stallGenerations: options.optimizer.stallGenerations }),
    });
    emit({
      type: 'optimized',
      iteration,
      distance: fitted.distance,
      initialDistance: fitted.initialDistance,
      stopped: fitted.de.stopped,
    });

    if (fitted.distance <= targetDistance) {
      attempts.push({
        iteration,
        reply,
        soundline: fitted.source,
        issues: fitted.issues,
        distance: fitted.distance,
        outcome: 'accepted',
      });
      emit({ type: 'done', outcome: 'accepted', accepted: true });
      return {
        ...base,
        accepted: true,
        outcome: 'accepted',
        soundline: fitted.source,
        ast: fitted.ast,
        issues: fitted.issues,
        distance: fitted.distance,
        initialDistance: fitted.initialDistance,
      };
    }

    /**
     * "The numbers are as good as this structure allows" has two forms.
     *
     * The designed one is a stalled search. The other is a recipe with no `~`
     * slots at all — nothing to fit, so the distance it renders at is the
     * distance that structure gives, and structure is the only thing left to
     * change. It is a common model output, too: a first attempt often writes
     * confident literals everywhere. Note the optimizer reports
     * `stopped: 'target'` for a zero-dimensional run, meaning "nothing to
     * optimize" rather than "target reached", so this cannot be read off `de`.
     */
    const stuck = fitted.de.stopped === 'stalled' || fitted.slots.length === 0;

    if (!stuck) {
      /* Still improving when the generation budget ran out. Asking for a new
         topology here would discard a search that was working; the caller's move
         is more generations, not another model call. */
      attempts.push({
        iteration,
        reply,
        soundline: fitted.source,
        issues: fitted.issues,
        distance: fitted.distance,
        outcome: 'distance',
      });
      emit({ type: 'done', outcome: 'distance', accepted: false });
      return {
        ...base,
        accepted: false,
        outcome: 'distance',
        soundline: fitted.source,
        ast: fitted.ast,
        issues: fitted.issues,
        distance: fitted.distance,
        initialDistance: fitted.initialDistance,
      };
    }

    /* Measure the fitted candidate once more: the diff has to describe the recipe
       the model is about to be shown, not the one it sent. */
    const directives = humanReadableDiff(
      extractProfile(await options.render(fitted.ast)),
      options.target.profile,
      fitted.ast,
    );

    /* The one place the model is asked to restructure. */
    const failure: Failure = {
      kind: 'stalled',
      distance: fitted.distance,
      targetDistance,
      directives,
    };
    const feedback = repairMessage(failure);
    attempts.push({
      iteration,
      reply,
      soundline: fitted.source,
      issues: fitted.issues,
      distance: fitted.distance,
      outcome: 'distance',
      feedback,
    });
    messages.push({ role: 'user', content: feedback });
    emit({ type: 'feedback', iteration, message: feedback });
  }

  /* Budget spent. Report the last attempt's verdict and the best recipe any
     attempt reached — a caller that got a valid-but-distant recipe on iteration 2
     and an unparseable one on iteration 4 should be handed the former. */
  const best = bestAttempt(attempts);
  const outcome = attempts.at(-1)?.outcome ?? 'no-soundline';
  emit({ type: 'done', outcome, accepted: false });
  return {
    ...base,
    accepted: false,
    outcome,
    soundline: best?.soundline ?? '',
    issues: best?.issues ?? [],
    ...(best?.distance === undefined ? {} : { distance: best.distance }),
  };
}

/** How far an attempt got. Higher is better; ties go to the later attempt. */
function rank(attempt: Attempt): number {
  switch (attempt.outcome) {
    case 'accepted':
      return 3;
    /* Valid, audible, and measured — just not close enough. */
    case 'distance':
      return 2;
    /* Parsed, so there is something a human can edit. */
    case 'invalid':
    case 'render':
      return 1;
    default:
      return 0;
  }
}

/**
 * The attempt worth returning when nothing was accepted.
 *
 * A caller that got a valid-but-distant recipe on iteration 2 and an unparseable
 * one on iteration 4 should be handed the former: the model does not always
 * improve, and the run's product is the best recipe it reached, not the last.
 */
function bestAttempt(attempts: readonly Attempt[]): Attempt | undefined {
  let best: Attempt | undefined;
  for (const attempt of attempts) {
    if (attempt.soundline === undefined) continue;
    if (best === undefined || rank(attempt) >= rank(best)) best = attempt;
  }
  return best;
}
