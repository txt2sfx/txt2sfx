/**
 * Entry point: read the environment, open the store, build the app, listen.
 *
 * ## Where the secrets are
 *
 * In the environment, and nowhere else. `GITHUB_CLIENT_SECRET` and
 * `TXT2SFX_ADMIN_TOKEN` never appear in a file in this repository and never travel to
 * the browser; `.env.example` documents their names. Everything else here is public
 * configuration that could be printed in a log.
 *
 * ## Configuration decides which server this is
 *
 * With a GitHub app configured this is the public bank: sign-in, attribution,
 * moderation. Without one it is a personal bank on a laptop with a single built-in
 * account, and it refuses to bind anything but loopback in that state — see
 * `assertSafeBinding`.
 *
 * @packageDocumentation
 */

import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type AuthContext, assertSafeBinding } from './auth.js';
import type { GitHubConfig } from './identity.js';
import { openBank } from './db.js';
import { openStore } from './store.js';
import { buildApp } from './app.js';

/** Where the database lives by default, relative to the package. */
const DEFAULT_DB = resolve(fileURLToPath(new URL('../data/recipes.db', import.meta.url)));

/** Resolved configuration. */
export interface ServerConfig {
  readonly databasePath: string;
  readonly port: number;
  readonly host: string;
  readonly auth: AuthContext;
  /** Serve an unauthenticated writable bank on a public interface. Deliberately awkward. */
  readonly allowOpen: boolean;
}

/** Split a comma- or space-separated list, dropping the empties. */
function listOf(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Read configuration from the environment, with defaults that just work.
 *
 * The callback URL is derived from `PUBLIC_URL` rather than configured separately:
 * it has to match what is registered with GitHub exactly, and two settings that must
 * agree are one setting and a bug waiting to happen.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env['PORT'] ?? 8787);
  const clientId = env['GITHUB_CLIENT_ID'] ?? '';
  const clientSecret = env['GITHUB_CLIENT_SECRET'] ?? '';
  const publicUrl = (env['PUBLIC_URL'] ?? '').replace(/\/+$/, '');

  const github: GitHubConfig | undefined =
    clientId !== '' && clientSecret !== '' && publicUrl !== ''
      ? {
          clientId,
          clientSecret,
          callbackUrl: `${publicUrl}/api/auth/github/callback`,
          /* The playground origins a session may be handed back to. `PUBLIC_URL` is
             included so that a bank serving its own page works with no extra
             setting. */
          allowedRedirects: [...listOf(env['ALLOWED_ORIGINS']), publicUrl],
        }
      : undefined;

  return {
    databasePath: env['TXT2SFX_DB'] ?? DEFAULT_DB,
    port: Number.isFinite(port) ? port : 8787,
    /* Loopback by default: a recipe bank on a laptop should not appear on the office
       network because someone ran `pnpm dev`. In production nginx is in front, so
       loopback is also the right answer there. */
    host: env['HOST'] ?? '127.0.0.1',
    auth: {
      mode: github === undefined ? 'solo' : 'github',
      ...(github === undefined ? {} : { github }),
      adminToken: env['TXT2SFX_ADMIN_TOKEN'] ?? '',
      /* Solo *and* told its own public URL: someone is running this behind a proxy
         with sign-in not yet configured, and writes have to wait for it. */
      publicWithoutSignIn: github === undefined && publicUrl !== '',
    },
    allowOpen: env['TXT2SFX_ALLOW_OPEN'] === '1',
  };
}

/**
 * Open the store for a configuration.
 *
 * Kept as a named export because the seeder wants the recipe bank alone and this is
 * where the path lives.
 */
export function openConfiguredStore(config: ServerConfig): ReturnType<typeof openStore> {
  return openStore(config.databasePath);
}

/** The recipe bank alone, for the seeder and the dump. */
export function openConfiguredBank(config: ServerConfig): ReturnType<typeof openBank> {
  return openConfiguredStore(config).recipes;
}

async function main(): Promise<void> {
  const config = configFromEnv();
  assertSafeBinding(config.auth.mode, config.host, config.allowOpen);

  const store = openConfiguredStore(config);
  const app = await buildApp({ store, auth: config.auth, logger: true });

  const shutdown = async (): Promise<void> => {
    await app.close();
    store.close();
  };
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));

  /* Expired sessions are swept once at startup rather than on a timer: the table is
     tiny, `resolve` already refuses an expired token, and a timer would be a second
     thing that can wedge a process whose whole job is to answer quickly. */
  const swept = store.identity.sweep();

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `recipe bank: ${String(store.recipes.count())} recipes at ${config.databasePath}; ` +
      `auth ${config.auth.mode}; ${String(swept)} expired session(s) swept; contract at GET /api/llms.txt`,
  );
  if (config.auth.mode === 'solo') {
    app.log.warn(
      config.auth.publicWithoutSignIn === true
        ? 'PUBLIC_URL is set but no identity provider is: serving reads and refusing every write. ' +
            'Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to open this bank for writing.'
        : 'no identity provider configured — every write is attributed to the built-in `local` account. ' +
            'Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and PUBLIC_URL to run this as a public bank.',
    );
  }
  if (config.auth.adminToken === '') {
    app.log.warn('TXT2SFX_ADMIN_TOKEN is not set — the moderation routes are not registered.');
  }
}

/* Only run when executed directly, so importing this module in a test or a script
   does not start listening on a port. `pathToFileURL` rather than string surgery: on
   Windows the argv path is `C:\...` and hand-built `file://` URLs disagree with
   `import.meta.url` about both the separators and the drive letter. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
