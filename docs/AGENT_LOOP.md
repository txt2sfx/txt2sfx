# The agent loop

`@txt2sfx/agent` is the only package that talks to a language model. It holds three
things: providers, the contract document the model is taught from, and the loop.

```ts
import { generateSound, geminiProvider, httpBank } from '@txt2sfx/agent';

const result = await generateSound({
  prompt: 'coin pickup sound for a platformer',
  provider: geminiProvider({ apiKey }),   // the key is always the user's
  render: renderSignal,                   // injected; this package owns no audio stack
  bank: httpBank('http://127.0.0.1:8787'),
  target,                                 // optional: a reference sound to match
});
// result.outcome: accepted | refused | no-soundline | parse-error | invalid | render | distance
```

## What the model is asked to do

Design structure. Everything checkable is checked deterministically, and the model only
hears about failures it can act on:

| stage | what it checks | what goes back to the model |
| --- | --- | --- |
| extract | is there a recipe in the reply at all | what a fenced block looks like |
| `parse` | syntax | the parser's own `line L, col C: … (hint)` — and nothing else, because an unparseable document has no invariants left to check |
| `validate` | category contract and physical invariants | `formatIssues`: rule id, what was written, what is required, and the `hint`, verbatim |
| `render` + `validateRender` | peak and near-silence — the two facts the text cannot predict | the same shape, plus the note that these were measured |
| `optimize` | distance to the target, by moving `~` slots only | *usually nothing* — see below |

Every message repeats one instruction: mark numbers you are unsure of as
`~value[min..max]`. Precision is not the model's job.

## The hard rule

**The model is asked for a structural change only when the numbers cannot help.** Two
forms of that:

- the optimizer *stalled* — best fitness did not move for `stallGenerations` generations
  and is still above the threshold;
- the recipe has **no `~` slots at all** — there is nothing to fit, so the distance it
  renders at is the distance this structure gives. (Note the optimizer reports
  `stopped: 'target'` for a zero-dimensional run, meaning "nothing to optimize" rather
  than "target reached", so this cannot be read off the DE result.)

When the search merely ran out of generations while still improving, the loop **stops and
reports the distance** rather than asking for a rewrite. The costs are asymmetric: a
wrongly-declared stall throws away a search that was working and sends the model off to
redesign a topology that did not need redesigning. That asymmetry is also why
`stallGenerations` is 20 — a third of the default budget — and not 12; measured on a
3-dimensional Rastrigin landscape, 12 stopped at more than twice the error the same run
reached when allowed to continue.

## Without a target

The common case in the playground is a prompt and no reference sound. There is then no
distance to minimize, and a recipe is accepted as soon as it parses, validates and
renders to something audible. That is the honest ceiling for "make me a laser":
correctness is checkable, resemblance is not.

With a reference — a recording dropped into the Compare panel, or another recipe's render
— the measured target profile also goes *into the first prompt*. A model told "duration
42 ms, dominant partial 836 Hz, flatness 0.001" designs a two-layer tonal transient; the
same model told only "bubble pop" writes whatever a bubble pop means to it, and the
optimizer cannot turn a noise layer into a tone.

## A refusal is an answer

The contract tells the model to decline, in one sentence, when the request is for
something procedural synthesis cannot do — a human voice, a believable animal, a
real-world recording. So a reply with **no code fence at all** ends the run with
`outcome: 'refused'` and the model's sentence in `message`. Sending "reply with a fenced
block" back to that sentence would produce exactly the disappointing sound the
instruction exists to prevent.

A reply that *does* contain a fence but no recipe is a formatting failure and is
repaired. A recipe with no fence is read anyway — that is a formatting slip, not a failed
attempt, and spending an iteration on it would be waste.

## Few-shot: prefer what validates

The bank is the few-shot source, and the bank is allowed to hold a recipe the validator
rejects — the seeder loads `helicopter` on purpose, so the bank is not left without its
only looped texture. That is fine for a human browsing the gallery and wrong for a model
reading examples: hand it `helicopter` and it may imitate the flaw, then be refused by the
same pipeline that supplied the example.

`selectFewShot` resolves it: fill the slate from recipes that pass validation, and prefer
*fewer* examples over one the conveyor would refuse. Fall back to flawed recipes only when
there are none clean — a prompt with no examples teaches nothing about the shape of the
language — and in that case name the rule each one breaks, so the model copies structure
and not the defect. `GET /api/llms.txt` applies the same filter to the examples it embeds,
so an outside agent gets the same protection.

This makes the question independent of what happens to `helicopter` itself: whether the
recipe is changed, the invariant is relaxed, or neither, the agent stops learning from an
example the conveyor rejects.

## The contract document

The system prompt is the generated contract (`llmsText`) plus the selected examples plus
the reply rules. The grammar is **not** written in the prompt: it comes from the same
tables the parser and the validator use, so a new primitive appears in the prompt the
moment it appears in the signature table. Prose duplicating the grammar is prose that
will be wrong.

The same document is served at `GET /api/llms.txt` for agents that have not installed
anything — one request, no round trips spent discovering the rules one error at a time.
One function, two consumers, because two documents would drift and the one that drifted
would be the one nobody reads while debugging.

## Providers

`LLMProvider` is one method: `complete({ system, messages, maxTokens, signal })`. Three
implementations ship: Anthropic, Gemini and a scripted mock.

They speak HTTP through `fetch` and depend on no vendor SDK. Two requirements decide
that: the packages carry zero runtime dependencies, and the playground has to work with a
key the user pastes into a browser tab — so the same provider code runs in Node and in a
page, and every byte of it ships to the browser. The cost is real: retries, error mapping
and response shapes are ours to maintain, which is why each request shape is documented
with the API version it was written against, and why the retry policy lives in one place.

Details that are not preferences:

- **Anthropic** sends no `temperature`, `top_p`, `top_k` or `thinking` configuration.
  Those are rejected with a 400 on the current model family, and there is a test that
  fails if someone adds one back. A `stop_reason` of `refusal` arrives as a *successful*
  200 with empty content, so it is checked before the text is read; a `max_tokens` stop is
  reported as an error rather than returned as a recipe, because half a recipe parses as
  far as it goes and then fails on a half-written layer.
- **Gemini** takes the key in the `x-goog-api-key` header, never in the query string: a
  key in a URL lands in proxy logs, browser history and `Referer` headers, and this one
  belongs to someone else.
- **The mock** consumes a script and *throws* when it runs out. A cycling mock turns a
  loop bug into an endless conversation that reads as slowness.
- Keys are never read from the environment by the providers themselves. The playground
  holds a pasted key in tab memory and passes it per call; a provider that quietly fell
  back to `process.env` would use the wrong key exactly when the two disagree.

Retries cover 408, 409, 429, 5xx, 529 and connection failures, with exponential backoff
and `retry-after` honoured but capped at a minute. A 400 is not retried, and the server's
own explanation is preserved in the error — both vendors say precisely what was wrong with
a rejected request, and replacing that with "request failed" would cost exactly the
debugging session the message was written for.

## Progress and transcripts

`onEvent` reports `request`, `reply`, `validated`, `rendered`, `optimized`, `feedback` and
`done`, so a UI can show the loop working rather than a spinner. `result.attempts` keeps
every reply, what was extracted from it, the issues, the distance and the feedback that
went back — which is what makes a bench row explain itself: `render → accepted` means the
loop caught a clipping buffer and the model fixed it.
