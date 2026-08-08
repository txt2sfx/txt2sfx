#!/usr/bin/env bash
#
# Apply one commit to the box. Installed at /srv/txt2sfx/deploy.sh, run over SSH by
# `.github/workflows/deploy-server.yml` with the SHA that just passed CI.
#
# ## Why the box builds
#
# The alternative is shipping a tarball, and that means deciding what goes in it: the
# `dist` of six workspace packages, a pruned `node_modules` with pnpm's symlink layout
# intact, and a native module (`node-web-audio-api`) built for this libc. Getting any of
# those wrong produces a service that starts and then fails on the first render, which
# is the worst shape a deploy failure can take. Building here runs the same three
# commands a developer runs, against a lockfile, on the Node this service will use.
#
# ## Why the database is not in the checkout
#
# `git reset --hard` is the first thing this does. Anything inside the working tree is
# disposable by construction, so the SQLite file lives in /srv/txt2sfx/data and the
# service is pointed at it by TXT2SFX_DB.
set -euo pipefail

SHA="${1:?usage: deploy.sh <commit-sha>}"
APP=/srv/txt2sfx/app

cd "$APP"

git fetch --quiet origin
# By SHA, never by branch: this must apply the commit that was tested, not whatever
# `main` points at by the time the connection opened.
git reset --hard --quiet "$SHA"
git clean -fdq -e node_modules

corepack pnpm install --frozen-lockfile --silent
corepack pnpm build

# The seed is idempotent by name and cheap, and it is what makes a fresh box useful
# rather than empty. Not --strict: `helicopter` is knowingly out of contract and is
# loaded with its error reported, which is the documented behaviour.
#
# The environment has to come with it. Without TXT2SFX_DB the seeder writes to the
# package default — a file inside the checkout, which `git clean` deletes on the next
# deploy — and the service, which reads /srv/txt2sfx/data, stays empty while the seeder
# reports success. That is the failure this line exists to prevent, and it was found by
# doing it wrong once.
set -a
# shellcheck disable=SC1091
. /srv/txt2sfx/env
set +a
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
echo "deployed ${SHA} — $(systemctl show -p ActiveState --value txt2sfx-bank)"
