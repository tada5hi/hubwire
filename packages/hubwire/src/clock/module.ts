import type { IClock } from './types';

/**
 * The process clock: `Date.now()` and the global `setTimeout` / `clearTimeout`,
 * with the timers as they are (not unref'd); `unref()` unrefs the Node.js timer.
 */
export const systemClock: IClock = {
    now: () => Date.now(),
    setTimeout(fn, ms) {
        const timer = setTimeout(fn, ms);
        // typed as the DOM's number where the DOM lib wins; Node.js returns a Timeout with unref()
        const handle: unknown = timer;

        return {
            clear: () => clearTimeout(timer),
            unref: () => {
                if (
                    typeof handle !== 'object' ||
                    handle === null ||
                    !('unref' in handle) ||
                    typeof handle.unref !== 'function'
                ) {
                    return;
                }

                handle.unref();
            },
        };
    },
};
