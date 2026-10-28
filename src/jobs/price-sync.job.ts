import { AppError } from '../errors';
import type { PriceService, SyncResult } from '../services/price.service';
import { silentLogger, type Logger } from '../utils/logger';

export interface PriceSyncJobOptions {
  intervalMs: number;
  logger?: Logger;
}

/**
 * Periodically synchronizes prices of all tracked cryptocurrencies.
 *
 * Runs are chained with setTimeout (not setInterval), so a slow upstream never causes overlapping
 * runs. stop() cancels the pending timer, aborts the in-flight request and waits for it to settle.
 */
export class PriceSyncJob {
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private started = false;
  private consecutiveFailures = 0;

  constructor(
    private readonly priceService: PriceService,
    private readonly options: PriceSyncJobOptions,
  ) {
    this.logger = options.logger ?? silentLogger;
  }

  get isRunning(): boolean {
    return this.started;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  /** Starts the job; the first synchronization happens immediately. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.logger.info('Price sync job started', { intervalMs: this.options.intervalMs });
    this.schedule(0);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abortController?.abort();
    await this.running;
    this.logger.info('Price sync job stopped');
  }

  /** Executes a single synchronization. Never throws: failures are logged and counted. */
  async runOnce(): Promise<SyncResult | null> {
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const result = await this.priceService.syncAll(controller.signal);
      this.consecutiveFailures = 0;
      this.logger.info('Prices synchronized', { ...result });
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        this.logger.info('Price sync aborted');
        return null;
      }
      this.consecutiveFailures++;
      this.logger.error('Price sync failed', {
        code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
        error: error instanceof AppError ? error.message : String(error),
        consecutiveFailures: this.consecutiveFailures,
      });
      return null;
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.runOnce().then(() => {
        this.running = null;
        if (this.started) this.schedule(this.options.intervalMs);
      });
    }, delayMs);
  }
}
