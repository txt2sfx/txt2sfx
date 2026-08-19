# @txt2sfx/agent

The LLM half of the [txt2sfx](https://github.com/txt2sfx/txt2sfx) pipeline: providers, the system prompt built from the live grammar tables, and the generate → validate → render → fit loop. Providers speak HTTP through `fetch` — zero runtime dependencies, and no API key of its own: the key comes from the caller.

Takes a render function you provide; no audio stack is bundled. The loop asks the model for a structural change only when the numerical optimizer is stuck — a search that is still improving is never thrown away.

All `@txt2sfx/*` packages are published in lockstep from one commit — install them at one version.

Apache-2.0.
