#!/usr/bin/env bash
#
# Build and restart. Run from the checkout by `bootstrap.sh`, which has already put the
# working tree at the commit named here — so this script is always the version that
# shipped with the code it is deploying. See bootstrap.sh for why that split exists.
#
# ## Why the box builds
#
# The alternative is shipping a tarball, and that means deciding what goes in it: the
# `dist` of six workspace packages, a pruned `node_modules` with pnpm's symlink layout
# intact, and a native module (`node-web-audio-api`) built for this libc. Getting any of
# those wrong produces a service that starts and then fails on the first render, which is
# the worst shape a deploy failure can take. Building here runs the same three commands a
# developer runs, against a lockfile, on the Node this service will use.
#
# ## Why the database is not in the checkout
#
# The checkout is disposable — `bootstrap.sh` resets and cleans it, ignored files
# included. The SQLite file lives in /srv/txt2sfx/data and the service is pointed at it
# by TXT2SFX_DB.
set -euo pipefail

SHA="${1:?usage: deploy.sh <commit-sha>}"
cd "$(dirname "$0")/../../.."

corepack pnpm install --frozen-lockfile --silent
corepack pnpm build

# ## The environment has to come with the seeder
#
# Without TXT2SFX_DB the seeder writes to the package default — a file inside the
# checkout — and the service, which reads /srv/txt2sfx/data, stays empty while the seed
# reports success. That happened; hence this block and the `-x` in bootstrap's clean.
set -a
# shellcheck disable=SC1091
. /srv/txt2sfx/env
set +a

# Idempotent by name and cheap, and it is what makes a fresh box useful rather than
# empty. Not --strict: `helicopter` is knowingly out of contract and is loaded with its
# error reported, which is the documented behaviour.
corepack pnpm --filter @txt2sfx/server seed || echo "seed reported problems; continuing"

sudo /bin/systemctl restart txt2sfx-bank

# Report rather than assume. The workflow polls /api/health through nginx afterwards,
# which is the check that matters; this one catches a unit that failed to start at all,
# where the journal line is right here and not three screens up.
sleep 2
systemctl is-active --quiet txt2sfx-bank || {
  echo "txt2sfx-bank did not stay up:"
  journalctl -u txt2sfx-bank -n 40 --no-pager
  exit 1
}
echo "deployed ${SHA} — $(systemctl show -p ActiveState --value txt2sfx-bank), $(sqlite3 "${TXT2SFX_DB}" 'select count(*) from recipes' 2>/dev/null || echo '?') recipe(s)"
