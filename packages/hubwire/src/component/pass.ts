import type { IClock } from '../clock';
import { invokeHook } from '../hook';
import type { ComponentStatus, ScheduledComponentHooks } from './types';

/**
 * Internal (not exported): what the scheduled and the interval component share.
 * One pass at a time (a pass requested during another joins it), its abort signal,
 * the status bookkeeping and settled(), plus a generation counter that start() and
 * stop() bump, so a loop that was stopped or restarted meanwhile arms nothing.
 */
export function createPassRunner<T>(clock: IClock, hooks: Pick<ScheduledComponentHooks, 'onError'> | undefined) {
    let generation = 0;
    let lastSuccessAt: number | undefined;
    let runningSince: number | undefined;
    // the pass in flight: a pass requested during it (a second start(), or one after a stop())
    // joins it instead of running a second pass next to it
    let pass: Promise<T> | undefined;
    let controller: AbortController | undefined;

    const run = async (body: (signal: AbortSignal) => Promise<T>) => {
        // one pass at a time (see execute()), so one controller at a time
        controller = new AbortController();

        try {
            return await body(controller.signal);
        } finally {
            controller = undefined;
        }
    };

    return {
        /**
         * Starts a new generation and returns it.
         */
        next(): number {
            generation++;

            return generation;
        },
        isCurrent(value: number): boolean {
            return value === generation;
        },
        isRunning(): boolean {
            return pass !== undefined;
        },
        /**
         * Runs `body` as the pass, or joins the pass in flight and resolves with its result.
         */
        execute(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
            // cleared asynchronously: a body that throws synchronously must not leave a settled pass behind
            pass ??= run(body).finally(() => {
                pass = undefined;
            });

            return pass;
        },
        /**
         * Runs `fn` as the measured part of a pass: runningSince while it runs, lastSuccessAt
         * when it resolves; a failure goes to hooks.onError and resolves `undefined`.
         */
        async measure<R>(fn: () => Promise<R> | R): Promise<{ value: R } | undefined> {
            runningSince = clock.now().getTime();

            try {
                const value = await fn();

                lastSuccessAt = clock.now().getTime();

                return { value };
            } catch (e) {
                invokeHook(hooks, 'onError', e);

                return undefined;
            } finally {
                runningSince = undefined;
            }
        },
        /**
         * Aborts the signal of the pass in flight, if any; it keeps running until it settles.
         */
        abort(): void {
            controller?.abort();
        },
        async settled(): Promise<void> {
            // ponytail: one pass at most; a pass started meanwhile (a start() after stop()) is not awaited
            await pass;
        },
        status(): ComponentStatus {
            return { lastSuccessAt, runningSince };
        },
    };
}
