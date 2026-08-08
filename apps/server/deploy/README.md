# Running the bank in public

The bank is the only part of txt2sfx that is a service somebody has to keep up. Every
other piece survives it: the playground is a static build, a share link carries the whole
recipe in its fragment, the export is a function you paste, and the corpus is dumped to
files that outlive this host. That is the design, and it is the reason a deploy here is
allowed to be simple.

The public instance is <https://txt2sfx.pix3.dev>, on a shared VPS that also serves other
sites. The files in this directory are what is installed on it.

| File | Installed as |
| --- | --- |
| [`txt2sfx-bank.service`](txt2sfx-bank.service) | `/etc/systemd/system/txt2sfx-bank.service` |
| [`nginx.conf`](nginx.conf) | `/etc/nginx/sites-available/txt2sfx.pix3.dev`, symlinked into `sites-enabled/` |
| [`bootstrap.sh`](bootstrap.sh) | `/srv/txt2sfx/deploy.sh` — the only file installed by hand |
| [`deploy.sh`](deploy.sh) | runs from the checkout; `bootstrap.sh` hands over to it |

## The layout on the box

```
/srv/txt2sfx/
  app/       the checkout — disposable, `git reset --hard` on every deploy
  data/      recipes.db and its WAL. The only thing that must be backed up.
  corpus/    the nightly dump, also served at /corpus/
  env        secrets, root:txt2sfx 0640
  deploy.sh
```

The service runs as the unprivileged `txt2sfx` user under a systemd sandbox that makes
everything read-only except `data/` and `corpus/`. It binds `127.0.0.1:8787`; nginx is the
only thing that can reach it.

## One-time preparation

```bash
useradd --system --create-home --home-dir /srv/txt2sfx --shell /bin/bash txt2sfx
install -d -o txt2sfx -g txt2sfx /srv/txt2sfx/{data,corpus}
install -d -o txt2sfx -g txt2sfx -m 0700 /srv/txt2sfx/.ssh
sudo -u txt2sfx git clone https://github.com/txt2sfx/txt2sfx.git /srv/txt2sfx/app

# Secrets. See `.env.example` for what each one is for.
install -o root -g txt2sfx -m 0640 /dev/null /srv/txt2sfx/env
$EDITOR /srv/txt2sfx/env

install -m 0755 /srv/txt2sfx/app/apps/server/deploy/bootstrap.sh /srv/txt2sfx/deploy.sh
install -m 0644 /srv/txt2sfx/app/apps/server/deploy/txt2sfx-bank.service /etc/systemd/system/
install -m 0644 /srv/txt2sfx/app/apps/server/deploy/nginx.conf /etc/nginx/sites-available/txt2sfx.pix3.dev
ln -s /etc/nginx/sites-available/txt2sfx.pix3.dev /etc/nginx/sites-enabled/

# The deploy user restarts its own service and nothing else.
cat > /etc/sudoers.d/txt2sfx <<'EOF'
txt2sfx ALL=(root) NOPASSWD: /bin/systemctl restart txt2sfx-bank, /bin/systemctl status txt2sfx-bank
EOF
chmod 0440 /etc/sudoers.d/txt2sfx

systemctl daemon-reload && systemctl enable --now txt2sfx-bank
```

**TLS before the vhost.** `nginx.conf` names a certificate, so nginx will refuse to start
until one exists — issue it behind a temporary port-80 server block, then swap:

```bash
certbot certonly --webroot -w /var/www/html -d txt2sfx.pix3.dev
```

Renewal is certbot's own timer; nothing here needs to know about it.

## Deploying

`bootstrap.sh` is deliberately the *only* deploy file installed on the box: it updates the
checkout and hands over to `deploy.sh` from that checkout, so the procedure is versioned
with the code it deploys. The first version of this was one script on the box, and it went
stale immediately — a fix that existed in git while the file being executed was a copy
installed weeks earlier.

Pushing to `main` a change that touches the server or anything it links against runs
[`deploy-server.yml`](../../../.github/workflows/deploy-server.yml): it repeats the full
gate (typecheck, tests, build), then SSHes in and runs `deploy.sh <sha>`, then polls
`/api/health` until the service answers. The commit is pinned by SHA — a deploy applies
what was tested, not whatever `main` points at by the time the connection opens.

Four repository secrets:

| Secret | What it is |
| --- | --- |
| `BANK_DEPLOY_HOST` | `txt2sfx.pix3.dev` |
| `BANK_DEPLOY_USER` | `txt2sfx` |
| `BANK_DEPLOY_KEY` | private half of an ed25519 key whose public half is in `/srv/txt2sfx/.ssh/authorized_keys` |
| `BANK_KNOWN_HOSTS` | output of `ssh-keyscan txt2sfx.pix3.dev`, **read off the box itself** rather than scanned from CI |

A rollback is `workflow_dispatch` on an older commit — the migrations are additive, so an
older server reads a newer database.

## Backups, and why they are small

`data/recipes.db` is the whole of it. Everything else on the box is a checkout of a public
repository plus a generated corpus.

```bash
sqlite3 /srv/txt2sfx/data/recipes.db ".backup '/srv/txt2sfx/data/backup.db'"
```

`.backup` rather than `cp`: the database is in WAL mode and a copied file without its
`-wal` is a database missing its most recent writes.

The corpus dump is the second line of defence and the more interesting one, because it is
readable without this software:

```bash
sudo -u txt2sfx corepack pnpm --filter @txt2sfx/server dump /srv/txt2sfx/corpus
```

Run it from a systemd timer and push the result to a public repository and the bank stops
being a single point of failure for the sounds people made in it.

## Moderation

The routes are registered only when `TXT2SFX_ADMIN_TOKEN` is set, and nginx confines them
to the loopback interface on top of that — so they are reachable from an SSH session and
from nowhere else:

```bash
TOKEN=$(sudo grep TXT2SFX_ADMIN_TOKEN /srv/txt2sfx/env | cut -d= -f2)
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/moderation/reports
curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"hidden":true}' http://127.0.0.1:8787/api/moderation/recipes/12/hidden
```

Hiding is reversible and leaves the row where a person can look at it again. Banning an
account drops its live sessions immediately, because a ban that waits for the next sign-in
is a ban that never arrives.
