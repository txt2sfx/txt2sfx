/**
 * Entry point: open the bank, build the app, listen.
 *
 * @packageDocumentation
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApp } from './app.js';
import { openBank } from './db.js';

/** Where the database lives by default, relative to the package. */
const DEFAULT_DB = resolve(fileURLToPath(new URL('../data/recipes.db', import.meta.url)));

/** Resolved configuration. Secrets are never involved — there is nothing to guard. */
export interface ServerConfig {
  readonly databasePath: string;
  readonly port: number;
  readonly host: string;
}

/** Read configuration from the environment, with defaults that just work. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env['PORT'] ?? 8787);
  return {
    databasePath: env['TXT2SFX_DB'] ?? DEFAULT_DB,
    port: Number.isFinite(port) ? port : 8787,
    /* Loopback by default: a recipe bank on a laptop should not appear on the
       office network because someone ran `pnpm dev`. */
    host: env['HOST'] ?? '127.0.0.1',
  };
}

/** Open the bank, creating the directory if this is a first run. */
export function openConfiguredBank(config: ServerConfig): ReturnType<typeof openBank> {
  if (config.databasePath !== ':memory:') mkdirSync(dirname(config.databasePath), { recursive: true });
  return openBank(config.databasePath);
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const bank = openConfiguredBank(config);
  const app = await buildApp({ bank, logger: true });

  const shutdown = async (): Promise<void> => {
    await app.close();
    bank.close();
  };
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `recipe bank: ${String(bank.count())} recipes at ${config.databasePath}; contract at GET /api/llms.txt`,
  );
}

/* Only run when executed directly, so importing this module in a test or a script
   does not start listening on a port. `pathToFileURL` rather than string surgery:
   on Windows the argv path is `C:\...` and hand-built `file://` URLs disagree with
   `import.meta.url` about both the separators and the drive letter. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
