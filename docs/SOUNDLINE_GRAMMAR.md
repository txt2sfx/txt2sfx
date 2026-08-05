# The soundline language

`soundline` is the unit of exchange in txt2sfx: a diffable text description of one
sound effect. Everything else is derived from it — the audio graph, the exported
JavaScript, the acoustic profile, the row in the recipe bank.

```
# Crisp interface tick: an impulse plus a tiny tonal body.
sound "ui click" 45ms ui
  tick: click 2ms >> hp 1200Hz | gain 0.6 decay 25ms
  body: tone sine 1800Hz | gain 0.25 decay 18ms
```

The exhaustive parameter tables — every primitive, every effect, units, ranges,
defaults — are **generated from the same tables the parser uses** and served at
`GET /api/llms.txt` (also available in-process as `llmsText()` from
`@txt2sfx/agent`). This document is the part that cannot be generated: the shape of
the language and the reasons behind it.

## Header

```
sound "<name>" <duration> [<category>] [loop]
```

- `name` is quoted and free-form; it appears in the export and in the bank.
- `duration` is the **contract**, not a description: the validator compares it against
  the duration the compiler estimates, tails included, and reports the overrun.
- `category` comes from a closed set —
  `pop | ui | laser | impact | explosion | pickup | foley | cycle | misc`. It is not a
  label, it is the set of physical invariants the sound agrees to be judged against.
  Without one there is nothing for the validator to attach an invariant to. `misc` is
  the default and is omitted when serializing.
- `loop` is a separate flag. The category for looped textures is `cycle`, and the
  validator requires the flag for it: a looped sound's declared duration is the period
  of the loop, so a buffer that outlives it has an audible seam.

## Layers

```
  <name>: <primitive> <args> [>> <effect> <args>]... | <envelope>
```

Two spaces of indentation, exactly. The name is not decoration: it appears in every
validator issue, every analyzer directive, and every diff, so name a layer after its
job (`body`, `snap`, `tail`) rather than after its primitive.

**Signal order is `source → envelope → chain → mix`**, even though it is written
`source >> chain | envelope`. The envelope shapes the source, and the effect chain runs
*after* it, so a `delay` or `verb` tail outlives the `decay` — which is why tails count
against the header's duration contract, and why `helicopter` can build a rotor out of a
sub thump recirculated through a delay. The written order is chosen for readability;
the compiler follows the signal order.

## Numbers

Every number carries a unit except dimensionless ratios: `Hz`, `kHz`, `ms`, `s`, `dB`.

Numbers are **stored as written**. `1.2kHz` is the value `1.2` with the unit `kHz`, not
`1200`; conversion happens only where a number is consumed (`toHz`, `toMs`, `toLinear`).
That is what makes `serialize(parse(src))` byte-identical to `src` on every example —
and byte-identical round-tripping is what lets a human and a model edit the same file
without either of them reformatting the other's work.

A closed set of dimensionless parameters may be written glued to their value (`Q6`), so
a layer named `snap2` stays one identifier. The serializer glues back only
single-character uppercase names, which is why it prints `Q6` but `gain 0.9`.

### Trajectories

```
<value> -> <target> in <time>
<value> -> lin <target> in <time>
1800Hz -> 900Hz in 60ms -> 200Hz in 40ms
```

Exponential by default, `lin` for linear, chained for multi-stage sweeps. Two rules the
compiler applies and the docs have to state:

- **Attack is always linear.** An exponential ramp cannot start at zero, and a ramp
  that starts anywhere else clicks.
- **An exponential ramp cannot reach zero.** It is clamped to −60 dBFS
  (`GLOBAL_LIMITS.minExpTarget`), an *absolute* floor rather than a relative one, so a
  quiet layer does not ring longer than a loud one. Writing `-> 0Hz` or `index -> 0` is
  a supported idiom meaning "fade to nothing"; the validator tells you what will
  actually happen instead of complaining about the range.

### Optimizable slots

```
~700Hz[500..1400]
```

A tilde marks a number the author is unsure about, with the range worth searching in
the same unit as the literal. The differential-evolution optimizer treats each slot as
one dimension, and the playground turns each into a slider. This is the language-level
expression of the project's third principle: **the model designs structure, a numerical
search finds the numbers.**

Slot bounds outside a parameter's documented range are a warning rather than an error —
the recipe still renders, but the author has given the optimizer permission to generate
an invalid sound, and finding that out here is cheaper than finding it out a thousand
candidates later.

## Comments

`#` starts a comment. File comments, comments on their own line above a layer, and
trailing comments all survive parsing, optimization and serialization. This matters
more than it looks: a comment is where the *reason* for a number lives, and a toolchain
that silently dropped comments would lose the only durable record of why `bubble-pop`
sweeps upward.

## Canonical form

The serializer is the single definition of canonical:

- two spaces of layer indentation;
- arguments in signature order;
- envelope in the order `gain attack hold decay curve delay`;
- comments preserved, blank lines dropped;
- only explicitly written arguments printed — defaults are applied by the compiler and
  never baked into the AST, because baking them in would break byte-exact
  round-tripping.

## Errors

Errors are reported per line: one broken layer does not hide the others
(`parseWithDiagnostics`). Lexical errors stop the parse, because a mis-tokenized file
has no reliable line structure left.

The message format is `line L, col C: <detail> (<hint>)`, written for two readers at
once — a human and a language model in a loop. Suggestions come from a synonym
dictionary plus Damerau–Levenshtein: `lowpass → lp`, `reverb → verb`, `sweep → chirp`,
`release → decay`, `volume → gain`, `nosie → noise`. The synonym table exists because
edit distance alone cannot connect `lowpass` to `lp` (distance 5), and `lowpass` is
exactly what a model writes. Every caught synonym saves an iteration.

## Physical invariants

The category table and the global limits live in `packages/shared/src/constants.ts`
with their reasoning, and are enforced by `validate()`. They are the project's opinion
about what a listener accepts as "a pop" or "a laser", not physics — and they are
stated as numbers precisely so a disagreement can be argued with a diff.

Two invariants cannot be read off the text and are checked on the render
(`validateRender`): the peak (layers do not peak at the same instant, and a high-pass
differentiates and can push the peak *above* its input) and near-silence (a recipe that
renders 40 dB down is never what anyone asked for, and nothing in the text says so).

See [ACOUSTIC_PROFILE.md](ACOUSTIC_PROFILE.md) for what is measured after the render,
and [AGENT_LOOP.md](AGENT_LOOP.md) for how these messages get back to the model.
