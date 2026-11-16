import { systemClock } from 'hubwire';
import type { IClock, IScheduleLock } from 'hubwire';
import type { MemoryScheduleLockOptions } from './types';


/**
 * In-process IScheduleLock for tests. Time comes from the `clock` option (default systemClock,
 * so vitest's fake timers drive expiry; a FakeClock drives it when given): a key acquired at T with `ttlMs` is free at exactly T + ttlMs.
 * `acquired` records every acquire that won, in order; `acquireError` makes acquire() reject
 * (and record nothing).
 */
export class MemoryScheduleLock implements IScheduleLock {
    acquired: { key: string, ttlMs: number }[] = [];

    acquireError: unknown;

    // key → epoch ms it expires at
    protected expiries = new Map<string, number>();

    protected clock: IClock;

    constructor(options: MemoryScheduleLockOptions = {}) {
        this.clock = options.clock ?? systemClock;
    }

    async acquire(key: string, ttlMs: number): Promise<boolean> {
        if (this.acquireError !== undefined) {
            throw this.acquireError;
        }

        // check and write without an await in between: two callers cannot both win
        const now = this.clock.now();

        for (const [held, expiresAt] of this.expiries) {
            if (expiresAt <= now) {
                this.expiries.delete(held);
            }
        }

        if (this.expiries.has(key)) {
            return false;
        }

        this.expiries.set(key, now + ttlMs);
        this.acquired.push({ key, ttlMs });

        return true;
    }
}
