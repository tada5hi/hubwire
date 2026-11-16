import { systemClock } from '../clock';
import type { ClockTimer } from '../clock';
import { createPassRunner } from './pass';
import type { IScheduledComponent, IntervalComponentOptions, IntervalResult } from './types';

// setTimeout's limit: a longer wait is armed in steps of at most this
const MAX_TIMER_MS = 2 ** 31 - 1;

type Decision = { done: true } | { done: false, delayMs: number };

/**
 * A background job on a fixed delay: a pass, then a wait of `intervalMs` from the moment
 * it settled, never overlapping. The pass's result can wait once for another delay or end
 * the loop (see IntervalResult). A failing pass is reported to hooks.onError and the loop
 * waits `intervalMs`. A start() while a pass is in flight means "keep running": if that pass
 * returns `{ done: true }`, the loop begins again as a fresh start() would; such a start() resolves
 * once that pass settled (a start() while the loop only waits does nothing). A loop that begins
 * while a pass is in flight waits for it: with runOnStart it follows that pass's result, else its
 * first wait starts when the pass settled. stop() clears that request, aborts the signal of a pass in
 * flight but does not wait for it;
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

    let timer: ClockTimer | undefined;
    let looping = false;
    // a start() arrived while a pass was in flight: a `{ done: true }` of that pass must not end the loop
    let requested = false;

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

        const restart = requested;

        requested = false;

        if (decision.done) {
            halt();

            if (restart) {
                void begin();
            }

            return;
        }

        looping = true;
        wait(current, clock.now() + decision.delayMs);
    };

    function wait(current: number, until: number) {
        timer = clock.setTimeout(() => {
            timer = undefined;

            const now = clock.now();

            if (now < until) {
                // a capped wait woke before the end of the delay
                wait(current, until);

                return;
            }

            void execute().then((decision) => follow(current, decision));
        }, Math.min(until - clock.now(), MAX_TIMER_MS));

        if (options.unref) {
            timer.unref?.();
        }
    }

    async function begin() {
        if (looping) {
            return;
        }

        const current = runner.next();

        if (options.runOnStart) {
            // runs a pass, or joins the one in flight and follows its result
            follow(current, await execute());

            return;
        }

        // a pass in flight (of a loop stopped meanwhile): the first wait starts when it settled
        await runner.inFlight();
        follow(current, { done: false, delayMs: intervalMs });
    }

    return {
        async start() {
            const inFlight = runner.inFlight();

            if (inFlight) {
                // keep running: a `{ done: true }` of this pass begins the loop again
                requested = true;
            }

            await begin();
            // joins the pass in flight also when the loop is already running
            await inFlight;
        },
        async stop() {
            // does not wait for a pass in flight (a pass may stop its own component), see settled();
            // only aborts its signal; nothing is armed after it
            requested = false;
            halt();
            runner.abort();
        },
        settled: () => runner.settled(),
        status: () => runner.status(),
    };
}
