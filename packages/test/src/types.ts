import type { IClock } from 'hubwire';

export type MemoryScheduleLockOptions = {
    /**
     * Where expiry reads the time. Default: systemClock (`new Date()`)
     */
    clock?: IClock,
};
