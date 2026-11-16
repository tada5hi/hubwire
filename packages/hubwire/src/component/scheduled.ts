import { Cron } from 'croner';
import { systemClock } from '../clock';
import type { ClockTimer } from '../clock';
import { invokeHook } from '../hook';
import { createPassRunner } from './pass';
import type {
    IScheduledComponent,
    ScheduledComponentHookContext,
    ScheduledComponentOptions,
    ScheduledComponentSkipReason,
} from './types';

// the longest a timer waits before the loop looks at the clock again: keeps a far slot
// below setTimeout's 2^31-1 ms limit and re-evaluates a slot croner answered in the past
const RECHECK_MS = 30_000;

const DEFAULT_LOCK_TTL_MS = 60_000;

/**
 * A background job: one pass in start() (unless disabled), then one per cron
 * tick, never overlapping. A failing pass is reported to hooks.onError and never rejects —
 * start() is typically fire-and-forget, the next tick retries.
 * stop() does not wait for a pass in flight; a shutdown awaits settled() after stop().
 * A pass must never await its own component's settled() — it would deadlock.
 */
export function defineScheduledComponent(options: ScheduledComponentOptions): IScheduledComponent {
    const clock = options.clock ?? systemClock;

    if (options.timezone !== undefined) {
        try {
            // croner itself rejects an unknown zone only lazily, on the first nextRun()
            Intl.DateTimeFormat('en-US', { timeZone: options.timezone });
        } catch {
            throw new Error(`Invalid timezone: ${options.timezone}`);
        }
    }

    // croner only evaluates the expression: it is never given a callback, so it arms no timer.
    // The loop below waits for each slot itself, so a pass knows the slot it runs for.
    let evaluator: Cron;

    try {
        evaluator = new Cron(options.schedule, {
            mode: '5-or-6-parts',
            paused: true,
            timezone: options.timezone,
        });
    } catch {
        // fail at definition, not after a full pass in start()
        throw new Error(`Invalid cron expression: ${options.schedule}`);
    }

    if (evaluator.nextRun(new Date(clock.now())) === null) {
        // e.g. 31 February: the component would start and silently never run
        throw new Error(`Cron expression has no future run: ${options.schedule}`);
    }

    if (options.lock && !options.name) {
        throw new Error('A scheduled component with a lock requires a name');
    }

    if (options.lockTtlMs !== undefined && !(Number.isFinite(options.lockTtlMs) && options.lockTtlMs > 0)) {
        // 0 or less would never hold a key, NaN is undefined behavior in the backend
        throw new Error(`Invalid lockTtlMs: ${options.lockTtlMs}`);
    }

    const lock = options.lock ?
        {
            instance: options.lock,
            name: options.name,
            ttlMs: options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
        } :
        undefined;

    let timer: ClockTimer | undefined;

    // every timer goes through here, so `unref` covers the slot wait, its capped re-waits and the recheck
    const setTimer = (fn: () => void, ms: number) => {
        timer = clock.setTimeout(fn, ms);

        if (options.unref) {
            timer.unref?.();
        }
    };
    let scheduled = false;
    // generations: a start() whose first pass was overtaken by a start() or stop() must not schedule afterwards
    const runner = createPassRunner<void, ScheduledComponentHookContext>(clock, options.hooks);
    // epoch ms of the last tick's slot (or of the moment scheduling began): the next slot lies after it
    let last = 0;

    const context = (scheduledAt: Date): ScheduledComponentHookContext => ({ scheduledAt, name: options.name });

    const skip = (scheduledAt: Date, reason: ScheduledComponentSkipReason) => {
        invokeHook(options.hooks, 'onSkip', scheduledAt, { ...context(scheduledAt), reason });
    };

    const run = async (scheduledAt: Date, locked: boolean, signal: AbortSignal) => {
        if (locked && lock) {
            let acquired: boolean;

            try {
                acquired = await lock.instance.acquire(`${lock.name}:${scheduledAt.toISOString()}`, lock.ttlMs);
            } catch (e) {
                // fail closed: the next tick tries again; no pass ran, so the status stays
                invokeHook(options.hooks, 'onError', e, context(scheduledAt));

                return;
            }

            if (!acquired) {
                skip(scheduledAt, 'locked');

                return;
            }
            // never released: the key is unique per tick, its TTL ends it
        }

        await runner.measure(() => options.run({ scheduledAt, signal }), context(scheduledAt));
    };

    // the start pass is not locked: its scheduledAt differs per replica, a lock could not dedupe it
    const execute = (scheduledAt: Date, locked: boolean) => runner.execute((signal) => run(scheduledAt, locked, signal));

    function arm() {
        const from = Math.max(clock.now(), last);
        // a Date drops the fraction of `from` (it floors): croner answers the first slot after
        // that whole ms, which the comparison below holds against the exact `from`
        const next = evaluator.nextRun(new Date(from));

        if (!next) {
            // the expression ran out of future runs (checked at definition, so only defensive)
            timer = undefined;

            return;
        }

        if (next.getTime() <= from) {
            // inside a repeated DST hour croner can answer with a past instant: look again later
            setTimer(arm, RECHECK_MS);

            return;
        }

        wait(next.getTime());
    }

    function wait(slot: number) {
        setTimer(() => {
            if (clock.now() < slot) {
                // a capped wait woke before the slot
                wait(slot);

                return;
            }

            last = slot;
            // re-arm before the pass: a pass that stops its own component clears this timer
            arm();

            if (lock && clock.now() - slot >= lock.ttlMs) {
                // fired so late (a stall, a sleep) that the tick's key may have expired after
                // another replica ran it: running it now could run it twice
                skip(new Date(slot), 'late');

                return;
            }

            if (runner.inFlight()) {
                // passes never overlap: the slot is dropped, not queued, and takes no lock
                skip(new Date(slot), 'running');

                return;
            }

            void execute(new Date(slot), true);
        }, Math.min(slot - clock.now(), RECHECK_MS));
    }

    return {
        async start() {
            if (scheduled) {
                return;
            }

            const current = runner.next();

            if (options.runOnStart ?? !lock) {
                await execute(new Date(clock.now()), false);
            }

            if (!runner.isCurrent(current)) {
                return;
            }

            scheduled = true;
            last = clock.now();
            arm();
        },
        async stop() {
            runner.next();

            // does not wait for a pass in flight (a pass may stop its own component), see settled();
            // only aborts its signal; nothing is scheduled after it
            scheduled = false;
            timer?.clear();
            timer = undefined;
            runner.abort();
        },
        settled: () => runner.settled(),
        status: () => runner.status(),
    };
}
