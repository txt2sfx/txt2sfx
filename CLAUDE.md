# CLAUDE.md

## Environment

`pnpm` is not on PATH on this machine; it is available through Corepack. Every `pnpm`
command in this file and in the package scripts must be run as `corepack pnpm …` from a
shell, even though CI and the documentation write it as plain `pnpm`.

## Releasing `txt2sfx-bridge`

Triggered by any request to publish, release or ship an update to the bridge — "опубликуй
обновление", "выпусти новую версию", "release the bridge". `packages/bridge` is the only
package in this repository that reaches a registry.

There is no manual publish step. Pushing a `bridge-v*` tag is what publishes, via
[`.github/workflows/publish-bridge.yml`](.github/workflows/publish-bridge.yml), which
authenticates with npm trusted publishing — no token exists to publish with by hand, and
a hand publish would land without a provenance attestation. `0.1.0` is already on the
registry that way; do not add to it.

### The procedure

1. **Pick the bump.** If the user did not say patch, minor or major, infer it from what
   changed since the last release and state the choice — do not ask unless the change
   genuinely reads both ways.

2. **Edit the version in two places.** They must agree or `test/hygiene.test.ts` fails:

   - `packages/bridge/package.json` → `version`
   - `packages/bridge/src/version.ts` → `VERSION`

   The constant exists because the shipped bundle is one file with no `package.json`
   beside it, so the version cannot be read from disk at runtime. This is the step that
   gets forgotten.

3. **Check the version is free.** `npm view txt2sfx-bridge@<version> version` must 404.
   Published versions are immutable; a wrong tag cannot be taken back, only superseded.

4. **Run the gates locally**: `corepack pnpm typecheck` and `corepack pnpm test`. The
   workflow runs them too, but a failure there leaves a tag pointing at a commit that can
   never be released under that version.

5. **Commit only the release.** The working tree usually carries unrelated work in
   progress — stage `packages/bridge/package.json` and `packages/bridge/src/version.ts`
   by name. Never `git add -A` for a release.

6. **Push the commit to `main`, then the tag.** The tag must name the same version as the
   manifest, prefixed exactly `bridge-v`, and must point at a commit that is already on
   the remote:

   ```
   git commit -m "release: txt2sfx-bridge <version>" packages/bridge/package.json packages/bridge/src/version.ts
   git push origin main
   git tag bridge-v<version>
   git push origin bridge-v<version>
   ```

7. **Report, do not assume.** Publishing happens in CI and takes minutes. Give the user
   the run URL (`gh run list --workflow publish-bridge.yml`) and say the release is in
   flight. Only call it published after the workflow's own attestation check has passed.

### If it fails

A failed run before the publish step can be fixed and the tag moved. A failed run *after*
the publish step cannot: that version is spent. Bump again and tag again rather than
retrying the same number.

### What not to touch without updating npm

The trusted publisher on npm is configured against this repository **and the filename**
`publish-bridge.yml`. Renaming or moving that workflow, or publishing from a different
one, breaks releases until the package's npm settings are changed to match.
