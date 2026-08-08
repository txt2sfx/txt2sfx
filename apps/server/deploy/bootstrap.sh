#!/usr/bin/env bash
#
# Installed once at /srv/txt2sfx/deploy.sh; this is what CI actually invokes.
#
# ## Why there are two scripts
#
# The first version of this was one script sitting on the box, and it went stale
# immediately: a fix to the deploy procedure lived in the repository while the file
# being executed was the copy installed by hand weeks earlier. The symptom was a seed
# that reported ten recipes stored into a database the service does not read, from a bug
# that had already been fixed in git.
#
# So: this file updates the checkout and hands over to the script that came with it.
# Everything about *how* to deploy is then versioned alongside the code it deploys, and
# a change to the procedure ships the same way a change to the server does. This file
# does only what cannot be versioned — getting to the version.
set -euo pipefail

SHA="${1:?usage: deploy.sh <commit-sha>}"
APP=/srv/txt2sfx/app

cd "$APP"
git fetch --quiet origin
# By SHA, never by branch: this must apply the commit that was tested, not whatever
# `main` points at by the time the connection opened.
git reset --hard --quiet "$SHA"
# `-x` as well as `-d`: without it, ignored files survive — including the SQLite file a
# misconfigured seeder once left in `apps/server/data`, which then looked seeded while
# the service read an empty database somewhere else.
git clean -fdxq -e node_modules

exec apps/server/deploy/deploy.sh "$SHA"
