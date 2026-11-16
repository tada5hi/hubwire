import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { FakeClock, drain } from '@hubwire/test';
import { defineIntervalComponent } from '../../src';
import type { IntervalResult } from '../../src';
import { UnrefClock } from './fakes/unref-clock';

// the timers that hold the event loop open (an unref'd one is not listed)
const refTimers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;

const START = Date.parse('2030-01-15T10:00:00.000Z');

/**
 * Records the clock time (ms since START) of every pass.
 */
function record(clock: FakeClock, results: IntervalResult[] = []) {
    const passes: number[] = [];
    let index = 0;

    return {
        passes,
        handler: () => {
            passes.push(clock.now() - START);

            return results[index++];
        },
    };
}

describe('src/component/interval', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('should run no pass at start() by default, then one after intervalMs', async () => {
        const clock = new FakeClock(START);
        const { passes, handler } = record(clock);
        const c = defineIntervalComponent({
            intervalMs: 1000, 
            clock, 
            handler, 
        });

        await c.start();
        expect(passes).toEqual([]);
        clock.advance(999);
        await drain();
        expect(passes).toEqual([]);
        clock.advance(1);
        await drain();
        expect(passes).toEqual([1000]);
        clock.advance(1000);
        await drain();
        expect(passes).toEqual([1000, 2000]);
        await c.stop();
    });

    it('should run a pass at start() with runOnStart', async () => {
        const clock = new FakeClock(START);
        const { passes, handler } = record(clock);
        const c = defineIntervalComponent({
            intervalMs: 1000,
            runOnStart: true,
            clock,
            handler,
        });

        await c.start();
        expect(passes).toEqual([0]);
        clock.advance(1000);
        await drain();
        expect(passes).toEqual([0, 1000]);
        await c.stop();
    });

    it('should arm no global timer', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        const baseline = vi.getTimerCount();
        const clock = new FakeClock(START);
        const { passes, handler } = record(clock);
        const c = defineIntervalComponent({
            intervalMs: 1000, 
            clock, 
            handler, 
        });

        await c.start();
        clock.advance(1000);
        await drain();
        expect(passes).toEqual([1000]);
        expect(vi.getTimerCount()).toBe(baseline);
        expect(clock.timerCount).toBe(1);
        await c.stop();
        expect(clock.timerCount).toBe(0);
    });

    it('should start the next wait when the pass settled', async () => {
        const clock = new FakeClock(START);
        const passes: number[] = [];
        let gate = Promise.withResolvers<void>();
        const c = defineIntervalComponent({
            intervalMs: 10_000,
            clock,
            handler: async () => {
                passes.push(clock.now() - START);
                await gate.promise;
            },
        });

        await c.start();
        clock.advance(10_000);
        await drain();
        expect(passes).toEqual([10_000]);
        // the pass takes 5 s: nothing is armed meanwhile
        clock.advance(5000);
        expect(clock.timerCount).toBe(0);
        gate.resolve();
        gate = Promise.withResolvers<void>();
        await drain();
        clock.advance(9999);
        await drain();
        expect(passes).toEqual([10_000]);
        clock.advance(1);
        await drain();
        expect(passes).toEqual([10_000, 25_000]);
        gate.resolve();
        await c.stop();
        await c.settled();
    });

    it('should run one pass when the clock jumps by many intervals, the next after it settled', async () => {
        const clock = new FakeClock(START);
        const { passes, handler } = record(clock);
        const c = defineIntervalComponent({
            intervalMs: 1000, 
            clock, 
            handler, 
        });

        await c.start();
        clock.advance(10 * 1000);
        await drain();
        expect(passes).toEqual([1000]);
        clock.advance(10 * 1000);
        await drain();
        expect(passes).toEqual([1000, 11_000]);
        await c.stop();
    });

    it('should never overlap passes', async () => {
        const clock = new FakeClock(START);
        const gate = Promise.withResolvers<void>();
        let running = 0;
        let maxRunning = 0;
        let passes = 0;
        const c = defineIntervalComponent({
            intervalMs: 1000,
            runOnStart: true,
            clock,
            handler: async () => {
                passes++;
                running++;
                maxRunning = Math.max(maxRunning, running);
                await gate.promise;
                running--;
            },
        });

        const started = c.start();

        clock.advance(5000);
        await drain();
        gate.resolve();
        await started;
        expect(passes).toBe(1);
        expect(maxRunning).toBe(1);
        await c.stop();
    });

    it('should wait delayMs once, then intervalMs again', async () => {
        const clock = new FakeClock(START);
        const { passes, handler } = record(clock, [{ delayMs: 500 }]);
        const c = defineIntervalComponent({
            intervalMs: 1000, 
            clock, 
            handler, 
        });

        await c.start();
        clock.advance(1000);
        await drain();
        clock.advance(500);
        await drain();
        expect(passes).toEqual([1000, 1500]);
        clock.advance(999);
        await drain();
        expect(passes).toEqual([1000, 1500]);
        clock.advance(1);
        await drain();
        expect(passes).toEqual([1000, 1500, 2500]);
        await c.stop();
    });

    it('should wait intervalMs after { done: false } without delayMs', async () => {
        const clock = new FakeClock(START);
        const { passes, handler } = record(clock, [{ done: false }]);
        const c = defineIntervalComponent({
            intervalMs: 1000, 
            clock, 
            handler, 
        });

        await c.start();
        clock.advance(1000);
        await drain();
        clock.advance(1000);
        await drain();
        expect(passes).toEqual([1000, 2000]);
        await c.stop();
    });

    it('should end the loop on { done: true } until the next start()', async () => {
        const clock = new FakeClock(START);
        const { passes, handler } = record(clock, [{ done: true }, undefined, { done: true }]);
        const c = defineIntervalComponent({
            intervalMs: 1000, 
            clock, 
            handler, 
        });

        await c.start();
        clock.advance(1000);
        await drain();
        expect(passes).toEqual([1000]);
        expect(clock.timerCount).toBe(0);
        expect(c.status()).toEqual({ lastSuccessAt: START + 1000, runningSince: undefined });
        await c.settled();
        clock.advance(10_000);
        await drain();
        expect(passes).toEqual([1000]);

        await c.start();
        clock.advance(1000);
        await drain();
        clock.advance(1000);
        await drain();
        expect(passes).toEqual([1000, 12_000, 13_000]);
        expect(clock.timerCount).toBe(0);
    });

    it('should honour runOnStart again on a start() after { done: true }', async () => {
        const clock = new FakeClock(START);
        const { passes, handler } = record(clock, [{ done: true }, { done: true }]);
        const c = defineIntervalComponent({
            intervalMs: 1000,
            runOnStart: true,
            clock,
            handler,
        });

        await c.start();
        expect(passes).toEqual([0]);
        expect(clock.timerCount).toBe(0);
        clock.advance(500);
        await c.start();
        expect(passes).toEqual([0, 500]);
        expect(clock.timerCount).toBe(0);
    });

    it('should let { done: true } win over delayMs', async () => {
        const clock = new FakeClock(START);
        const errors: unknown[] = [];
        const { passes, handler } = record(clock, [{ done: true, delayMs: 5 }]);
        const c = defineIntervalComponent({
            intervalMs: 1000,
            clock,
            handler,
            hooks: {
                onError: (error) => {
                    errors.push(error);
                },
            },
        });

        await c.start();
        clock.advance(1000);
        await drain();
        clock.advance(10_000);
        await drain();
        expect(passes).toEqual([1000]);
        expect(errors).toEqual([]);
        expect(clock.timerCount).toBe(0);
    });

    it('should count an invalid delayMs as a failed pass and continue after intervalMs', async () => {
        for (const delayMs of [0, -1, NaN, Infinity, '5' as unknown as number]) {
            const clock = new FakeClock(START);
            const errors: unknown[] = [];
            const { passes, handler } = record(clock, [{ delayMs }]);
            const c = defineIntervalComponent({
                intervalMs: 1000,
                clock,
                handler,
                hooks: {
                    onError: (error) => {
                        errors.push(error);
                    },
                },
            });

            await c.start();
            clock.advance(1000);
            await drain();
            expect(errors).toHaveLength(1);
            expect(String(errors[0])).toContain(`Invalid delayMs: ${String(delayMs)}`);
            expect(c.status().lastSuccessAt).toBeUndefined();
            clock.advance(999);
            await drain();
            expect(passes).toEqual([1000]);
            clock.advance(1);
            await drain();
            expect(passes).toEqual([1000, 2000]);
            expect(c.status().lastSuccessAt).toBe(START + 2000);
            await c.stop();
        }
    });

    it('should report a throwing or rejecting handler to onError and continue', async () => {
        const clock = new FakeClock(START);
        const errors: unknown[] = [];
        const thrown = new Error('thrown');
        const rejected = new Error('rejected');
        let passes = 0;
        const c = defineIntervalComponent({
            intervalMs: 1000,
            clock,
            hooks: {
                onError: (error) => {
                    errors.push(error);
                },
            },
            handler: () => {
                passes++;

                if (passes === 2) {
                    throw thrown;
                }

                if (passes === 3) {
                    return Promise.reject(rejected);
                }

                return undefined;
            },
        });

        await c.start();
        clock.advance(1000);
        await drain();
        expect(c.status().lastSuccessAt).toBe(START + 1000);

        clock.advance(1000);
        await drain();
        clock.advance(1000);
        await drain();
        expect(errors).toEqual([thrown, rejected]);
        expect(c.status().lastSuccessAt).toBe(START + 1000);
        expect(c.status().runningSince).toBeUndefined();

        clock.advance(1000);
        await drain();
        expect(passes).toBe(4);
        expect(c.status().lastSuccessAt).toBe(START + 4000);
        await c.stop();
    });

    it('should ignore a throwing onError', async () => {
        const clock = new FakeClock(START);
        let passes = 0;
        const c = defineIntervalComponent({
            intervalMs: 1000,
            clock,
            hooks: {
                onError: () => {
                    throw new Error('hook');
                },
            },
            handler: () => {
                passes++;

                throw new Error('x');
            },
        });

        await c.start();
        clock.advance(1000);
        await drain();
        clock.advance(1000);
        await drain();
        expect(passes).toBe(2);
        await c.stop();
    });

    it('should abort the signal of the pass in flight on stop() and arm nothing after it', async () => {
        const clock = new FakeClock(START);
        const gate = Promise.withResolvers<void>();
        const signals: AbortSignal[] = [];
        let done = false;
        const c = defineIntervalComponent({
            intervalMs: 1000,
            clock,
            handler: async ({ signal }) => {
                signals.push(signal);
                await gate.promise;
                done = true;

                return { delayMs: 10 };
            },
        });

        await c.start();
        clock.advance(1000);
        await drain();
        expect(signals).toHaveLength(1);
        expect(signals[0]?.aborted).toBe(false);
        expect(c.status().runningSince).toBe(START + 1000);

        await c.stop();
        expect(signals[0]?.aborted).toBe(true);

        const settled = c.settled().then(() => done);

        gate.resolve();
        await expect(settled).resolves.toBe(true);
        expect(clock.timerCount).toBe(0);
        clock.advance(10_000);
        await drain();
        expect(signals).toHaveLength(1);
        expect(c.status().runningSince).toBeUndefined();
    });

    it('should report a pass that throws because of the abort to onError', async () => {
        const clock = new FakeClock(START);
        const errors: unknown[] = [];
        const c = defineIntervalComponent({
            intervalMs: 1000,
            clock,
            hooks: {
                onError: (error) => {
                    errors.push(error);
                },
            },
            handler: ({ signal }) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason));
            }),
        });

        await c.start();
        clock.advance(1000);
        await drain();
        await c.stop();
        await c.settled();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(DOMException);
        expect(clock.timerCount).toBe(0);
    });

    it('should hand each pass a fresh signal', async () => {
        const clock = new FakeClock(START);
        const signals: AbortSignal[] = [];
        const c = defineIntervalComponent({
            intervalMs: 1000,
            clock,
            handler: ({ signal }) => {
                signals.push(signal);
            },
        });

        await c.start();
        clock.advance(1000);
        await drain();
        clock.advance(1000);
        await drain();
        expect(signals).toHaveLength(2);
        expect(signals[0]).not.toBe(signals[1]);
        await c.stop();
        expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    });

    it('should let a start() during the first pass join it', async () => {
        const clock = new FakeClock(START);
        const gate = Promise.withResolvers<void>();
        let passes = 0;
        const c = defineIntervalComponent({
            intervalMs: 1000,
            runOnStart: true,
            clock,
            handler: async () => {
                passes++;
                await gate.promise;
            },
        });

        const started = Promise.all([c.start(), c.start()]);

        gate.resolve();
        await started;
        expect(passes).toBe(1);
        expect(clock.timerCount).toBe(1);
        clock.advance(1000);
        await drain();
        expect(passes).toBe(2);
        await c.stop();
    });

    describe('start() during a pass', () => {
        const define = (clock: FakeClock, results: IntervalResult[], runOnStart = false) => {
            const passes: number[] = [];
            const gates: PromiseWithResolvers<void>[] = [];
            let index = 0;
            const component = defineIntervalComponent({
                intervalMs: 1000,
                runOnStart,
                clock,
                handler: async () => {
                    passes.push(clock.now() - START);

                    const gate = Promise.withResolvers<void>();

                    gates.push(gate);
                    await gate.promise;

                    return results[index++];
                },
            });

            return {
                component, 
                passes, 
                gates, 
            };
        };

        it('should keep the loop running when the pass returns { done: true }', async () => {
            const clock = new FakeClock(START);
            const {
                component: c, 
                passes, 
                gates, 
            } = define(clock, [{ done: true }]);

            await c.start();
            clock.advance(1000);
            await drain();
            void c.start();
            gates[0]?.resolve();
            await drain();
            expect(clock.timerCount).toBe(1);
            clock.advance(1000);
            await drain();
            expect(passes).toEqual([1000, 2000]);
            gates[1]?.resolve();
            await c.stop();
        });

        it('should run a new pass at once with runOnStart when the pass returns { done: true }', async () => {
            const clock = new FakeClock(START);
            const {
                component: c, 
                passes, 
                gates, 
            } = define(clock, [{ done: true }], true);
            const started = c.start();

            await drain();

            // the start pass is in flight: this start() joins it
            const again = c.start();

            gates[0]?.resolve();
            await Promise.all([started, again]);
            await drain();
            expect(passes).toEqual([0, 0]);
            gates[1]?.resolve();
            await drain();
            expect(clock.timerCount).toBe(1);
            await c.stop();
        });

        it('should change nothing when the pass returns nothing or { delayMs }', async () => {
            const clock = new FakeClock(START);
            const {
                component: c, 
                passes, 
                gates, 
            } = define(clock, [undefined, { delayMs: 500 }]);

            await c.start();
            clock.advance(1000);
            await drain();
            void c.start();
            gates[0]?.resolve();
            await drain();
            expect(clock.timerCount).toBe(1);
            clock.advance(1000);
            await drain();
            void c.start();
            gates[1]?.resolve();
            await drain();
            expect(clock.timerCount).toBe(1);
            clock.advance(500);
            await drain();
            expect(passes).toEqual([1000, 2000, 2500]);
            gates[2]?.resolve();
            await c.stop();
        });

        it('should end stopped after start() then stop() during the pass', async () => {
            const clock = new FakeClock(START);
            const {
                component: c, 
                passes, 
                gates, 
            } = define(clock, [{ done: true }]);

            await c.start();
            clock.advance(1000);
            await drain();
            void c.start();
            await c.stop();
            gates[0]?.resolve();
            await c.settled();
            await drain();
            expect(clock.timerCount).toBe(0);
            clock.advance(10_000);
            await drain();
            expect(passes).toEqual([1000]);
        });

        it('should stay a no-op while the loop only waits', async () => {
            const clock = new FakeClock(START);
            const {
                component: c, 
                passes, 
                gates, 
            } = define(clock, [{ done: true }]);

            await c.start();
            await c.start();
            clock.advance(1000);
            await drain();
            gates[0]?.resolve();
            await drain();
            expect(passes).toEqual([1000]);
            expect(clock.timerCount).toBe(0);
        });
    });

    describe('a pass in flight', () => {
        it('should start the first wait of a loop restarted during a pass when that pass settled', async () => {
            const clock = new FakeClock(START);
            const passes: number[] = [];
            const gate = Promise.withResolvers<void>();
            const c = defineIntervalComponent({
                intervalMs: 1000,
                clock,
                handler: async () => {
                    passes.push(clock.now() - START);

                    if (passes.length === 1) {
                        await gate.promise;
                    }
                },
            });

            await c.start();
            clock.advance(1000);
            await drain();
            clock.advance(100);
            await c.stop();
            void c.start();
            clock.advance(400);
            gate.resolve();
            await drain();
            clock.advance(600);
            await drain();
            expect(passes).toEqual([1000]);
            clock.advance(399);
            await drain();
            expect(passes).toEqual([1000]);
            clock.advance(1);
            await drain();
            expect(passes).toEqual([1000, 2500]);
            expect(clock.timerCount).toBe(1);
            await c.stop();
        });

        it('should join the pass in flight when restarted with runOnStart', async () => {
            const clock = new FakeClock(START);
            const passes: number[] = [];
            const gate = Promise.withResolvers<void>();
            const c = defineIntervalComponent({
                intervalMs: 1000,
                runOnStart: true,
                clock,
                handler: async () => {
                    passes.push(clock.now() - START);

                    if (passes.length === 1) {
                        await gate.promise;
                    }
                },
            });
            const started = c.start();

            clock.advance(100);
            await c.stop();

            const restarted = c.start();

            clock.advance(400);
            gate.resolve();
            await Promise.all([started, restarted]);
            expect(passes).toEqual([0]);
            clock.advance(999);
            await drain();
            expect(passes).toEqual([0]);
            clock.advance(1);
            await drain();
            expect(passes).toEqual([0, 1500]);
            await c.stop();
        });

        it('should not resolve a start() during a timer-started pass before the pass settled', async () => {
            const clock = new FakeClock(START);
            const gate = Promise.withResolvers<void>();
            let settled = false;
            const c = defineIntervalComponent({
                intervalMs: 1000,
                clock,
                handler: async () => {
                    await gate.promise;
                    settled = true;
                },
            });

            await c.start();
            clock.advance(1000);
            await drain();

            const joined = c.start().then(() => settled);

            await drain();
            gate.resolve();
            await expect(joined).resolves.toBe(true);
            await c.stop();
        });

        it('should not start a second pass when a handler calls start() before its first await', async () => {
            const clock = new FakeClock(START);
            const gate = Promise.withResolvers<void>();
            const signals: AbortSignal[] = [];
            let running = 0;
            let maxRunning = 0;
            const c = defineIntervalComponent({
                intervalMs: 1000,
                runOnStart: true,
                clock,
                handler: async ({ signal }) => {
                    signals.push(signal);
                    running++;
                    maxRunning = Math.max(maxRunning, running);
                    void c.start();
                    await gate.promise;
                    running--;
                },
            });
            const started = c.start();

            await drain();
            expect(signals).toHaveLength(1);
            await c.stop();
            expect(signals[0]?.aborted).toBe(true);
            gate.resolve();
            await started;
            await c.settled();
            expect(maxRunning).toBe(1);
        });
    });

    it('should run one loop when started twice', async () => {
        const clock = new FakeClock(START);
        const { passes, handler } = record(clock);
        const c = defineIntervalComponent({
            intervalMs: 1000, 
            clock, 
            handler, 
        });

        await c.start();
        await c.start();
        expect(clock.timerCount).toBe(1);
        clock.advance(1000);
        await drain();
        clock.advance(1000);
        await drain();
        expect(passes).toEqual([1000, 2000]);
        await c.stop();
    });

    it('should not run two passes at once when restarted during the old pass', async () => {
        const clock = new FakeClock(START);
        const gate = Promise.withResolvers<void>();
        let running = 0;
        let maxRunning = 0;
        let passes = 0;
        const c = defineIntervalComponent({
            intervalMs: 1000,
            clock,
            handler: async () => {
                passes++;
                running++;
                maxRunning = Math.max(maxRunning, running);

                if (passes === 1) {
                    await gate.promise;
                }

                running--;
            },
        });

        await c.start();
        clock.advance(1000);
        await drain();
        await c.stop();

        // joins the old pass: resolves once it settled
        const restarted = c.start();

        clock.advance(1000);
        await drain();
        expect(passes).toBe(1);
        gate.resolve();
        await restarted;
        await drain();
        clock.advance(1000);
        await drain();
        expect(passes).toBe(2);
        expect(maxRunning).toBe(1);
        expect(clock.timerCount).toBe(1);
        await c.stop();
    });

    it('should stay stopped when a pass stops its own component', async () => {
        const clock = new FakeClock(START);
        let passes = 0;
        const c = defineIntervalComponent({
            intervalMs: 1000,
            clock,
            handler: async () => {
                passes++;
                await c.stop();
            },
        });

        await c.start();
        clock.advance(1000);
        await drain();
        await c.settled();
        clock.advance(10_000);
        await drain();
        expect(passes).toBe(1);
        expect(clock.timerCount).toBe(0);
        expect(c.status()).toEqual({ lastSuccessAt: START + 1000, runningSince: undefined });
    });

    it('should resolve settled() at once when no pass is running', async () => {
        const clock = new FakeClock(START);
        const c = defineIntervalComponent({
            intervalMs: 1000, 
            clock, 
            handler: () => {}, 
        });

        await c.settled();
        await c.start();
        await c.settled();
        await c.stop();
        await c.settled();
    });

    it('should reject an intervalMs that is not a positive finite number', () => {
        for (const intervalMs of [0, -1, NaN, Infinity]) {
            expect(() => defineIntervalComponent({ intervalMs, handler: () => {} }))
                .toThrow(`Invalid intervalMs: ${intervalMs}`);
        }
    });

    it('should wait an interval longer than one timer can', async () => {
        const clock = new FakeClock(START);
        const { passes, handler } = record(clock);
        const intervalMs = 2 ** 31 + 1000;
        const c = defineIntervalComponent({
            intervalMs, 
            clock, 
            handler, 
        });

        await c.start();
        // one uncapped timer would count as 1 ms and fire now
        clock.advance(1000);
        await drain();
        expect(passes).toEqual([]);
        clock.advance(intervalMs - 1001);
        await drain();
        expect(passes).toEqual([]);
        clock.advance(1);
        await drain();
        expect(passes).toEqual([intervalMs]);
        await c.stop();
    });

    describe('unref', () => {
        it('should unref every timer it arms, also the steps of a long wait', async () => {
            const clock = new UnrefClock(START);
            let passes = 0;
            const c = defineIntervalComponent({
                intervalMs: 1000,
                unref: true,
                clock,
                handler: () => {
                    passes++;

                    return passes === 1 ? { delayMs: 2 ** 31 + 1000 } : undefined;
                },
            });

            await c.start();
            clock.advance(1000);
            await drain();
            clock.advance(2 ** 31 + 1000);
            await drain();
            clock.advance(1000);
            await drain();
            await c.stop();
            expect(passes).toBe(3);
            expect(clock.armedCount).toBeGreaterThan(3);
            expect(clock.unrefCount).toBe(clock.armedCount);
        });

        it('should unref no timer by default', async () => {
            const clock = new UnrefClock(START);
            const c = defineIntervalComponent({
                intervalMs: 1000,
                clock,
                handler: () => {},
            });

            await c.start();
            clock.advance(3000);
            await drain();
            await c.stop();
            expect(clock.armedCount).toBeGreaterThan(1);
            expect(clock.unrefCount).toBe(0);
        });

        it('should not hold the event loop open on the system clock with unref', async () => {
            const baseline = refTimers();
            const held = defineIntervalComponent({ intervalMs: 60_000, handler: () => {} });
            const unrefed = defineIntervalComponent({
                intervalMs: 60_000,
                unref: true,
                handler: () => {},
            });

            try {
                await unrefed.start();
                expect(refTimers()).toBe(baseline);
                await held.start();
                expect(refTimers()).toBe(baseline + 1);
            } finally {
                await unrefed.stop();
                await held.stop();
            }
        });
    });

    it('should take status() times from the clock', async () => {
        const clock = new FakeClock(START);
        const gate = Promise.withResolvers<void>();
        const c = defineIntervalComponent({
            intervalMs: 1000,
            clock,
            handler: () => gate.promise,
        });

        await c.start();
        expect(c.status()).toEqual({ lastSuccessAt: undefined, runningSince: undefined });
        clock.advance(1000);
        expect(c.status().runningSince).toBe(START + 1000);
        clock.advance(250);
        gate.resolve();
        await drain();
        expect(c.status()).toEqual({ lastSuccessAt: START + 1250, runningSince: undefined });
        await c.stop();
    });

    it('should use the system clock by default', async () => {
        vi.useFakeTimers({ now: START });

        const baseline = vi.getTimerCount();
        let passes = 0;
        const c = defineIntervalComponent({
            intervalMs: 1000,
            handler: () => {
                passes++;
            },
        });

        await c.start();
        expect(vi.getTimerCount()).toBe(baseline + 1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(passes).toBe(2);
        expect(c.status().lastSuccessAt).toBe(START + 2000);
        await c.stop();
        expect(vi.getTimerCount()).toBe(baseline);
    });
});
