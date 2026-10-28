import type { Server } from 'node:http';
import type { Db } from './db/database';
import type { PriceSyncJob } from './jobs/price-sync.job';
import type { Logger } from './utils/logger';

export interface ShutdownDeps {
  server: Server;
  job: PriceSyncJob | null;
  db: Db;
  logger: Logger;
  /** Hard deadline after which the process is terminated anyway */
  timeoutMs?: number;
  exit?: (code: number) => void;
}

export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** Runs `shutdown` on SIGINT/SIGTERM. Returns a function that removes the handlers. */
export function registerSignalHandlers(
  shutdown: (signal: string) => Promise<void>,
  target: Pick<NodeJS.EventEmitter, 'once' | 'removeListener'> = process,
): () => void {
  const handlers = SHUTDOWN_SIGNALS.map((signal) => {
    const handler = () => void shutdown(signal);
    target.once(signal, handler);
    return { signal, handler };
  });
  return () => handlers.forEach(({ signal, handler }) => target.removeListener(signal, handler));
}

/**
 * Builds an idempotent graceful shutdown routine: stops background jobs (aborting in-flight
 * requests), stops accepting connections, waits for active requests and closes the database.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let shuttingDown: Promise<void> | null = null;

  return (signal: string) => {
    if (shuttingDown) return shuttingDown;
    deps.logger.info('Shutting down', { signal });

    const forceExit = setTimeout(() => {
      deps.logger.error('Graceful shutdown timed out, forcing exit');
      exit(1);
    }, deps.timeoutMs ?? 10_000);
    forceExit.unref();

    shuttingDown = (async () => {
      let code = 0;
      try {
        await deps.job?.stop();
        await new Promise<void>((resolve, reject) => {
          deps.server.close((err) => (err ? reject(err) : resolve()));
          deps.server.closeIdleConnections();
        });
        deps.db.close();
        deps.logger.info('Shutdown complete');
      } catch (error) {
        code = 1;
        deps.logger.error('Error during shutdown', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(forceExit);
      }
      exit(code);
    })();
    return shuttingDown;
  };
}
