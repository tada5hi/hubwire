import { systemClock } from '../clock';
import { createPassRunner } from './pass';
import type { IScheduledComponent, IntervalComponentOptions, IntervalResult } from './types';

// setTimeout's limit: a longer wait is armed in steps of at most this
const MAX_TIMER_MS = 2 ** 31 - 1;

type Decision = { done: true } | { done: false, delayMs: number };

/**
 * A background job on a fixed delay: a pass, then a wait of `intervalMs` from the moment
 * it settled, never overlapping. The pass's result can wait once for another delay or end
 * the loop (see IntervalResult). A failing pass is reported to hooks.onError and the loop
 * waits `intervalMs`. stop() aborts the signal of a pass in flight but does not wait for it;
 * a shutdown awaits settled() after stop(). A pass must never await its own component's
 * settled(): it would deadlock.
 */
export function defineIntervalComponent(options: IntervalComponentOptions): IScheduledComponent {
    const { intervalMs } = options;

    if (!(Number.isFinite(intervalMs) && intervalMs > 0)) {
        throw new Error(`Invalid intervalMs: ${intervalMs}`);
    }

    const clock = options.clock ?? systemClock;
    const runner = createPassRunner<Decision>(clock, options.hooks);

    let timer: { clear(): void } | undefined;
    let looping = false;

    const decide = (result: IntervalResult): Decision => {
        if (typeof result !== 'object' || result === null) {
            return { done: false, delayMs: intervalMs };
        }

        if (result.done) {
            return { done: true };
        }

        if (result.delayMs === undefined) {
            return { done: false, delayMs: intervalMs };
        }

        if (typeof result.delayMs !== 'number' || !Number.isFinite(result.delayMs) || result.delayMs <= 0) {
            throw new Error(`Invalid delayMs: ${String(result.delayMs)}`);
        }

        return { done: false, delayMs: result.delayMs };
    };

    const execute = () => runner.execute(async (signal) => {
        const outcome = await runner.measure(async () => decide(await options.handler({ signal })));

        // a failed pass (also an invalid delayMs) waits the interval
        return outcome ? outcome.value : { done: false, delayMs: intervalMs };
    });

    const halt = () => {
        runner.next();
        looping = false;
        timer?.clear();
        timer = undefined;
    };

    // after a pass of generation `current` decided: wait for the next one or end
    const follow = (current: number, decision: Decision) => {
        if (!runner.isCurrent(current)) {
            // stopped or restarted meanwhile: whoever did owns the loop now
            return;
        }

        if (decision.done) {
            halt();

            return;
        }

        looping = true;
        wait(current, clock.now().getTime() + decision.delayMs);
    };

    function wait(current: number, until: number) {
        timer = clock.setTimeout(() => {
            timer = undefined;

            const now = clock.now().getTime();

            if (now < until) {
                // a capped wait woke before the end of the delay
                wait(current, until);

                return;
            }

            void execute().then((decision) => follow(current, decision));
        }, Math.min(until - clock.now().getTime(), MAX_TIMER_MS));
    }

    return {
        async start() {
            if (looping) {
                return;
            }

            const current = runner.next();

            if (options.runOnStart) {
                follow(current, await execute());

                return;
            }

            follow(current, { done: false, delayMs: intervalMs });
        },
        async stop() {
            // does not wait for a pass in flight (a pass may stop its own component), see settled();
            // only aborts its signal; nothing is armed after it
            halt();
            runner.abort();
        },
        settled: () => runner.settled(),
        status: () => runner.status(),
    };
}
