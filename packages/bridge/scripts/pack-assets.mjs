/**
 * Copy the Stable Audio scripts into `dist/` so the published bridge carries them.
 *
 * The bridge is installed with `npx txt2sfx-bridge` by people who do not have this
 * repository, and the Model tab's install button has to work for them: it drives
 * `run.py`, which is checked in under `test/stable-audio/` and is *not* reachable from
 * a published package unless it is copied here first. `src/stable-audio.ts` looks for
 * these two files next to the bundle, then falls back to the checkout — so a developer
 * running from source keeps using the repository's own copy and its already-provisioned
 * venv, and nothing is duplicated on their disk.
 *
 * They are copied rather than bundled because they are not JavaScript: esbuild has
 * nothing to do with a Python script, and a `.py` embedded in the `.mjs` as a string
 * would be a second copy of the file to keep in step.
 */

import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', '..', 'test', 'stable-audio');
const to = join(here, '..', 'dist', 'stable-audio');

await mkdir(to, { recursive: true });
for (const name of ['run.py', 'requirements.txt']) {
  await copyFile(join(from, name), join(to, name));
  process.stderr.write(`packed ${name}\n`);
}
