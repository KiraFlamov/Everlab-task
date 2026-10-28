import type { Server } from 'node:http';
import type { Db } from './db/database';
import type { PriceSyncJob } from './jobs/price-sync.job';
import type { Logger } from './utils/logger';

export interface ShutdownDeps {
  server: Server;
  job: PriceSyncJob | null;
  db: Db;
  /** Its signal is passed to HTTP handlers; aborting it cancels their CoinMarketCap requests */
  requestsAbortController?: AbortController;
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
 * Builds an idempotent graceful shutdown routine: stops accepting connections, aborts in-flight
 * CoinMarketCap requests (of HTTP handlers and of the background job), waits for active HTTP
 * requests to finish and closes the database. Without the abort, a handler stuck in CMC retries
 * (up to ~31 s with default settings) would outlive the forced-exit deadline.
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
      let idleSweeper: NodeJS.Timeout | undefined;
      try {
        const serverClosed = new Promise<void>((resolve, reject) => {
          deps.server.close((err) => (err ? reject(err) : resolve()));
        });
        // close() only drops connections idle at call time; keep-alive connections whose in-flight
        // response finishes later would otherwise hold it open until the keep-alive timeout
        deps.server.closeIdleConnections();
        idleSweeper = setInterval(() => deps.server.closeIdleConnections(), 50).unref();
        // Handlers waiting for CMC fail fast (503 or stored prices) instead of blocking server.close()
        deps.requestsAbortController?.abort();
        await deps.job?.stop();
        await serverClosed;
        deps.db.close();
        deps.logger.info('Shutdown complete');
      } catch (error) {
        code = 1;
        deps.logger.error('Error during shutdown', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(forceExit);
        clearInterval(idleSweeper);
      }
      exit(code);
    })();
    return shuttingDown;
  };
}
