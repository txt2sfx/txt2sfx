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

The optimizer is told to refine *this* design, not to find the best-scoring sound in
the search space. Those are different objectives and the metric cannot tell them
apart: it is peak-normalized and onset-aligned, so a broadband wash with the right
envelope and centroid trajectory outscores a recognizable version of what was asked
for. Two settings carry the difference (`optimizer.initialSpread`,
`optimizer.anchor`) — the population starts around the recipe instead of over the
whole cube, and drifting away from it costs fitness. Neither is a cage: a candidate
that is genuinely much closer still wins. Without them a fit against a reference
reliably ends somewhere else, which is how they came to exist.

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
redesign a topology that did not need redesigning. That asymmetry is also why the stall
window is **a third of the generation budget** and not a quarter; measured on a
3-dimensional Rastrigin landscape, a window of 12 against a budget of 60 stopped at more
than twice the error the same run reached when allowed to continue.

The window scales with the budget (`stallWindowFor`) rather than being the constant 20 that
suits the default 60, and that is not tidiness. A caller that shortens a run — the
playground does, to keep a browser responsive — used to inherit a window *larger than its
own budget*, which can never be reached: `stopped` could then only be `'target'` or
`'budget'`, and this entire branch became unreachable in silence.

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

`onEvent` reports `retrieval`, `request`, `reply`, `validated`, `rendered`, `generation`,
`optimized`, `feedback` and `done`, so a UI can show the loop working rather than a
spinner. `result.attempts` keeps every reply, what was extracted from it, the issues, the
distance and the feedback that went back — which is what makes a bench row explain itself:
`render → accepted` means the loop caught a clipping buffer and the model fixed it.

The `generation` event carries the leader **as a recipe**, not only its fitness, because a
number cannot be listened to and the failure worth catching mid-search is inaudible in the
number: a candidate that scores better while sounding like something else looks exactly
like healthy progress. It also carries `distance` beside `bestFitness` — the distance with
the penalties taken back out, so a live line and the final verdict cannot disagree.

## Stopping

`signal` reaches the search, not only the model call. It is checked before every
candidate render, and the run returns normally with `stopped: 'aborted'` and the best
individual it had reached — so cancelling costs the user the rest of the wait and nothing
else. An abandoned generation is deliberately **not** a stall: nothing was learned about
the landscape, and `stalled` is the one signal that sends a model off to redesign a
topology, which is the last thing a cancelled run should pay for.

## In the playground

The prompt row is this loop with a form in front of it (`apps/web/src/lib/agent.ts`,
`components/PromptRow.tsx`). What the browser adds is small and specific:

- **Nobody picks a provider.** `chooseProvider` decides: an attached coding agent if there
  is one — it holds a model already and needs no key — otherwise the user's Gemini key,
  otherwise nothing, said before the button is pressed rather than after. One pure
  function, read by the button, the label beside it, the dialog, the captioning step and
  NeurosLoop's composer, so none of them can claim a different model than the one called.
  The playground offers no other vendor: a choice between five ways to answer the same
  question was work the user had no way to do well.
- **The key is React state**, passed to the provider factory when a run starts and held
  nowhere else — no `localStorage`, no module-level cache. Closing the tab forgets it,
  unless **remember** was ticked, which encrypts it into IndexedDB under a non-extractable
  key (`lib/keystore.ts`).
- **The devtools provider is reachable from nowhere in the interface.** It is passed to
  the run as an explicit override by `window.txt2sfx.run`, which exists only under
  `vite dev` — an escape hatch nobody can click has no business in a table the interface
  reads.
- **The optimizer runs smaller than in the benchmark** (16 × 44 rather than 24 × 60): every
  generation is a population's worth of offline renders on the UI thread, and a search that
  takes a minute reads as a hang. When a result is close but not close enough, the Slots
  panel is the same search by hand, and audible immediately.
- **The fit is watchable.** The leader of each generation is rendered and drawn between
  generations, with a play button and a `⤓ take it` that ends the run and hands the
  candidate to the editor. `■ Stop` reaches the search itself and keeps what it found.
  Before that it reached the model call and nothing else: a cancelled run went quiet while
  a population of renders per generation kept the thread, and the recipe it had reached was
  thrown away — so pressing Stop cost the machine *and* the wait it was cutting short.
- **The search is held to the recipe** (`anchor` and `initialSpread`, both 0.25) for the
  reason in the table above. This is where the absence was found: an accepted
  `game-bubble-pop`, a bit eight-bit but right, came back after 44 silent generations as a
  different sound with a better number.
- **`match reference`** turns a reference loaded in the Compare panel into the loop's
  `target`, so the model is told what to aim at and the optimizer has a distance to
  minimize. Without it a recipe is accepted as soon as it parses, validates and renders to
  something audible — the honest ceiling for "make me a laser".

The log the panel prints is one line per event, which is the argument of the whole project
in miniature: the validator caught the category, the render caught the clipping, the
optimizer moved the numbers, and the model was asked again only when there was something it
could act on.

## Retrieval: rewriting the query

The bank is English and its index is FTS5, so a request in another language matches
nothing at all — «большой камень плюхнулся в озеро» finds zero rows, `retrieve` answers
with top-rated recipes, and the run reports three examples unrelated to the request while
looking perfectly healthy. `rewriteQuery: true` spends one short call (`searchQuery`,
`maxTokens: 64`) turning the request into 3–8 English keywords; `retrievalQuery` overrides
it when the caller already has them, and neither is used when there is no bank, since the
rewrite would have no consumer.

It is allowed to fail quietly, on the same grounds as a bank being down: retrieval is an
improvement to the prompt, not a precondition. A reply that arrives as prose is *rejected*
rather than trimmed (`parseKeywords`), because the caller has a perfectly good fallback and
a trimmed sentence would look like keywords without being any.

The `retrieval` event reports the query, the number of examples and the `fallback` flag —
worth its own event because three examples that matched nothing look exactly like three
that did.

## Being the model yourself

Under `vite dev` the page installs `window.txt2sfx` (`apps/web/src/lib/bridge.ts`), whose
model is whoever is holding the debugger. `txt2sfx.run` hands that provider to the run
directly rather than selecting it — it is a debugging instrument and has no entry anywhere
in the interface. The request is parked, you answer it by hand, and everything downstream
runs unchanged.

```js
await txt2sfx.loadReference('/@fs/C:/repo/.refs/splash.wav')  // or use the file picker
txt2sfx.run('a stone plunging into a lake', { target: true })
txt2sfx.request()                       // { id, turn, messages, systemBytes }
txt2sfx.system()                        // the 12 KB generated contract, on demand
txt2sfx.reply(id, '```soundline\n…\n```')
txt2sfx.measure()                       // profile, issues, distance, directives
txt2sfx.fit()                           // more generations, by hand
```

Why it earns its place: tuning the loop against a hosted model is a slow, noisy experiment —
every change costs a round trip and a different sample, so two runs never disagree for one
reason. Answer the request with a recipe you believe in, and the run tells you whether the
fault was ever upstream. It is also how the honest answer to "why is this output bad?" gets
found: on the first sound tried this way, a poor result turned out to be three separate
faults, only one of which was the model's — a stall window larger than the generation budget
(so the restructure branch was unreachable), a repair budget spent on syntax before the
first measurement, and a topology the numbers could not rescue.

`measure()` reads through a ref rather than a closure, deliberately: an earlier version
returned the previous render's numbers to a caller who asked right after a run, and stale
measurements are worse than none — they look like results.
