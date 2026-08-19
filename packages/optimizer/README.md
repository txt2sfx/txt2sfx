# @txt2sfx/optimizer

Differential evolution over a soundline's `~value[min..max]` slots, from [txt2sfx](https://github.com/txt2sfx/txt2sfx). Candidates are text, not ASTs: values are written back into the source at each literal's span and re-parsed, so the measured candidate is exactly the writable candidate. The DE implementation is local — zero runtime dependencies.

Takes a render function you provide; no audio stack is bundled. Pairs with `@txt2sfx/core` and `@txt2sfx/analyzer`.

All `@txt2sfx/*` packages are published in lockstep from one commit — install them at one version.

Apache-2.0.
