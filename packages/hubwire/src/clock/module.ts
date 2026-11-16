import type { IClock } from './types';

/**
 * The process clock: `Date.now()` and the global `setTimeout` / `clearTimeout`,
 * with the timers as they are (not unref'd).
 */
export const systemClock: IClock = {
    now: () => Date.now(),
    setTimeout(fn, ms) {
        const timer = setTimeout(fn, ms);

        return { clear: () => clearTimeout(timer) };
    },
};
