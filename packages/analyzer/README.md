# @txt2sfx/analyzer

Acoustic measurement for [txt2sfx](https://github.com/txt2sfx/txt2sfx): profile extraction from rendered samples, the scale-normalized, onset-aligned distance metric the optimizer minimizes, and human-readable diffs between profiles. The FFT is local — zero runtime dependencies.

Pairs with `@txt2sfx/core` (which renders the samples) and `@txt2sfx/optimizer` (which minimizes the distance).

All `@txt2sfx/*` packages are published in lockstep from one commit — install them at one version.

Apache-2.0.
