import { describe, expect, it } from 'vitest';
import { FakeClock, drain } from '@hubwire/test';
import { defineComponentGroup, defineScheduledComponent } from '../../src';
import type { ComponentGroupHooks, ComponentStatus, IComponent } from '../../src';

type Failure = 'throw' | 'reject';

/**
 * Records start / stop / settled calls (and their completion) into a shared log.
 */
class FakeComponent implements IComponent {
    starts = 0;

    stops = 0;

    settles = 0;

    startFailure: Failure | undefined;

    stopFailure: Failure | undefined;

    settledFailure: Failure | undefined;

    startGate: Promise<void> | undefined;

    stopGate: Promise<void> | undefined;

    settledGate: Promise<void> | undefined;

    statusValue: ComponentStatus = {};

    settled?: () => Promise<void>;

    constructor(
        readonly name: string,
        readonly log: string[],
        withSettled = true,
    ) {
        if (withSettled) {
            this.settled = () => {
                this.settles++;
                this.log.push(`settled:${this.name}`);

                if (this.settledFailure === 'throw') {
                    throw new Error(`settled ${this.name}`);
                }

                return this.finish(this.settledGate, this.settledFailure, `settled ${this.name}`, `settled-done:${this.name}`);
            };
        }
    }

    start(): Promise<void> {
        this.starts++;
        this.log.push(`start:${this.name}`);

        if (this.startFailure === 'throw') {
            throw new Error(`start ${this.name}`);
        }

        return this.finish(this.startGate, this.startFailure, `start ${this.name}`, `start-done:${this.name}`);
    }

    stop(): Promise<void> {
        this.stops++;
        this.log.push(`stop:${this.name}`);

        if (this.stopFailure === 'throw') {
            throw new Error(`stop ${this.name}`);
        }

        return this.finish(this.stopGate, this.stopFailure, `stop ${this.name}`, `stop-done:${this.name}`);
    }

    status(): ComponentStatus {
        return this.statusValue;
    }

    private async finish(gate: Promise<void> | undefined, failure: Failure | undefined, message: string, done: string) {
        // completes a microtask later at the earliest, as an async component would
        await gate;

        if (failure === 'reject') {
            throw new Error(message);
        }

        this.log.push(done);
    }
}

function setup(names: string[], hooks?: ComponentGroupHooks) {
    const log: string[] = [];
    const group = defineComponentGroup({ hooks });
    const components = names.map((name) => {
        const component = new FakeComponent(name, log);

        group.add(name, component);

        return component;
    });

    return {
        log,
        group,
        components,
    };
}

function recordingHooks() {
    const failures: Array<[string, string]> = [];
    const hooks: ComponentGroupHooks = {
        onStopFailed(name, error) {
            failures.push([name, (error as Error).message]);
        },
    };

    return { failures, hooks };
}

describe('src/group/module', () => {
    it('should start the components in add order, one at a time', async () => {
        const {
            log, 
            group, 
            components, 
        } = setup(['a', 'b']);
        const gate = Promise.withResolvers<void>();

        components[0]!.startGate = gate.promise;

        const started = group.start();

        await drain();
        expect(log).toEqual(['start:a']);

        gate.resolve();
        await started;
        expect(log).toEqual(['start:a', 'start-done:a', 'start:b', 'start-done:b']);
    });

    it('should stop every component in reverse add order before it awaits any', async () => {
        const {
            log, 
            group, 
            components, 
        } = setup(['a', 'b', 'c']);

        await group.start();
        log.length = 0;

        const gate = Promise.withResolvers<void>();

        for (const component of components) {
            component.stopGate = gate.promise;
        }

        const stopped = group.stop();

        await drain();
        expect(log).toEqual(['stop:c', 'stop:b', 'stop:a']);

        gate.resolve();
        await stopped;
        expect(log.slice(0, 6)).toEqual(['stop:c', 'stop:b', 'stop:a', 'stop-done:c', 'stop-done:b', 'stop-done:a']);
    });

    it('should stop every component before it awaits any settled()', async () => {
        const {
            log, 
            group, 
            components, 
        } = setup(['a', 'b']);

        await group.start();
        log.length = 0;

        const gate = Promise.withResolvers<void>();

        components[0]!.stopGate = gate.promise;

        const stopped = group.stop();

        await drain();
        expect(log).toEqual(['stop:b', 'stop:a', 'stop-done:b']);

        gate.resolve();
        await stopped;
        expect(log).toEqual([
            'stop:b',
            'stop:a',
            'stop-done:b',
            'stop-done:a',
            'settled:b',
            'settled:a',
            'settled-done:b',
            'settled-done:a',
        ]);
    });

    it('should resolve stop() only after every settled() resolved', async () => {
        const { group, components } = setup(['a']);

        await group.start();

        const gate = Promise.withResolvers<void>();

        components[0]!.settledGate = gate.promise;

        let done = false;
        const stopped = group.stop().then(() => {
            done = true;
        });

        await drain();
        expect(done).toBe(false);

        gate.resolve();
        await stopped;
        expect(done).toBe(true);
    });

    it('should stop components without settled()', async () => {
        const log: string[] = [];
        const group = defineComponentGroup();
        const component = new FakeComponent('a', log, false);

        group.add('a', component);

        await group.start();
        await group.stop();
        await group.settled();

        expect(log).toEqual(['start:a', 'start-done:a', 'stop:a', 'stop-done:a']);
    });

    for (const failure of ['throw', 'reject'] as const) {
        it(`should stop and settle the others when a stop() fails (${failure})`, async () => {
            const { failures, hooks } = recordingHooks();
            const { group, components } = setup(['a', 'b', 'c'], hooks);

            await group.start();
            components[1]!.stopFailure = failure;

            await expect(group.stop()).resolves.toBeUndefined();

            expect(components.map((c) => c.stops)).toEqual([1, 1, 1]);
            expect(components.map((c) => c.settles)).toEqual([1, 1, 1]);
            expect(failures).toEqual([['b', 'stop b']]);
        });

        it(`should settle the others when a settled() fails (${failure})`, async () => {
            const { failures, hooks } = recordingHooks();
            const {
                log, 
                group, 
                components, 
            } = setup(['a', 'b', 'c'], hooks);

            await group.start();
            components[1]!.settledFailure = failure;

            await expect(group.stop()).resolves.toBeUndefined();

            expect(components.map((c) => c.settles)).toEqual([1, 1, 1]);
            expect(log).toContain('settled-done:a');
            expect(log).toContain('settled-done:c');
            expect(failures).toEqual([['b', 'settled b']]);
        });

        it(`should resolve settled() when a component's settled() fails (${failure})`, async () => {
            const {
                log, 
                group, 
                components, 
            } = setup(['a', 'b']);

            components[0]!.settledFailure = failure;

            await expect(group.settled()).resolves.toBeUndefined();
            expect(log).toContain('settled-done:b');
        });
    }

    it('should resolve settled() only once every settled() resolved', async () => {
        const { group, components } = setup(['a', 'b']);
        const gate = Promise.withResolvers<void>();

        components[1]!.settledGate = gate.promise;

        let done = false;
        const settled = group.settled().then(() => {
            done = true;
        });

        await drain();
        expect(done).toBe(false);

        gate.resolve();
        await settled;
        expect(done).toBe(true);
    });

    it('should keep the outcome when the hook throws', async () => {
        const hooks: ComponentGroupHooks = {
            onStopFailed() {
                throw new Error('hook');
            },
        };
        const { group, components } = setup(['a', 'b'], hooks);

        await group.start();
        components[0]!.stopFailure = 'reject';
        components[1]!.settledFailure = 'throw';

        await expect(group.stop()).resolves.toBeUndefined();
        expect(components.map((c) => c.stops)).toEqual([1, 1]);
        expect(components.map((c) => c.settles)).toEqual([1, 1]);
    });

    it('should stop only once on a second stop()', async () => {
        const { group, components } = setup(['a', 'b']);

        await group.start();

        await Promise.all([group.stop(), group.stop()]);
        await group.stop();

        expect(components.map((c) => c.stops)).toEqual([1, 1]);
    });

    it('should do nothing on stop() when not started', async () => {
        const { group, components } = setup(['a']);

        await group.stop();

        expect(components[0]!.stops).toBe(0);
        expect(components[0]!.settles).toBe(0);
    });

    it('should stop again after a new start()', async () => {
        const { group, components } = setup(['a']);

        await group.start();
        await group.stop();
        await group.start();
        await group.stop();

        expect(components[0]!.starts).toBe(2);
        expect(components[0]!.stops).toBe(2);
    });

    it('should do nothing on start() when started, and join a start() in flight', async () => {
        const { group, components } = setup(['a']);
        const gate = Promise.withResolvers<void>();

        components[0]!.startGate = gate.promise;

        const first = group.start();
        const second = group.start();

        await drain();
        gate.resolve();
        await Promise.all([first, second]);
        await group.start();

        expect(components[0]!.starts).toBe(1);
    });

    it('should stop the component being started at once on stop(), and start none after it', async () => {
        const {
            log,
            group,
            components,
        } = setup(['a', 'b', 'c']);
        const gate = Promise.withResolvers<void>();

        components[1]!.startGate = gate.promise;

        const started = group.start();

        await drain();

        const stopped = group.stop();

        await drain();
        // b learns about the stop while its start() is still in flight
        expect(log).toEqual(['start:a', 'start-done:a', 'start:b', 'stop:b', 'stop-done:b']);

        gate.resolve();
        await Promise.all([started, stopped]);
        expect(log.slice(5)).toEqual([
            'start-done:b',
            'stop:a',
            'stop-done:a',
            'settled:b',
            'settled:a',
            'settled-done:b',
            'settled-done:a',
        ]);
        expect(components[1]!.stops).toBe(1);
        expect(components[2]!.starts).toBe(0);
    });

    it('should start nothing when stopped right after start()', async () => {
        const { log, group } = setup(['a']);
        const started = group.start();
        const stopped = group.stop();

        await Promise.all([started, stopped]);
        expect(log).toEqual([]);
    });

    it('should report a failing stop() of the component being started', async () => {
        const { failures, hooks } = recordingHooks();
        const { group, components } = setup(['a'], hooks);
        const gate = Promise.withResolvers<void>();

        components[0]!.startGate = gate.promise;
        components[0]!.stopFailure = 'throw';

        const started = group.start();

        await drain();

        const stopped = group.stop();

        gate.resolve();
        await Promise.all([started, stopped]);
        expect(failures).toEqual([['a', 'stop a']]);
        expect(components[0]!.settles).toBe(1);
    });

    it('should not hang when stopped during a scheduled component\'s start pass that waits for its abort', async () => {
        const entered = Promise.withResolvers<void>();
        let passes = 0;
        const job = defineScheduledComponent({
            schedule: '0 0 1 1 *',
            clock: new FakeClock(),
            run: ({ signal }) => {
                passes++;
                entered.resolve();

                return new Promise<void>((resolve) => {
                    signal.addEventListener('abort', () => resolve());
                });
            },
        });
        const group = defineComponentGroup();

        group.add('job', job);

        const started = group.start();

        await entered.promise;
        await expect(Promise.all([started, group.stop()])).resolves.toBeDefined();
        expect(passes).toBe(1);
        expect(job.status().runningSince).toBeUndefined();
    });

    it('should keep the registered name when a component\'s status carries a name of its own', () => {
        const group = defineComponentGroup();
        const component = new FakeComponent('internal', []);

        component.statusValue = { name: 'internal', lastRunAt: 1 } as ComponentStatus;
        group.add('public', component);

        expect(group.status()).toEqual({ components: [{ name: 'public', lastRunAt: 1 }] });
    });

    for (const failure of ['throw', 'reject'] as const) {
        it(`should stop and settle the started components when a start() fails (${failure}), then reject`, async () => {
            const { failures, hooks } = recordingHooks();
            const {
                log, 
                group, 
                components, 
            } = setup(['a', 'b', 'c', 'd'], hooks);

            components[2]!.startFailure = failure;
            components[0]!.stopFailure = 'reject';

            await expect(group.start()).rejects.toThrow('start c');

            expect(log).toEqual([
                'start:a',
                'start-done:a',
                'start:b',
                'start-done:b',
                'start:c',
                'stop:b',
                'stop:a',
                'stop-done:b',
                'settled:b',
                'settled:a',
                'settled-done:b',
                'settled-done:a',
            ]);
            expect(components.map((c) => c.stops)).toEqual([1, 1, 0, 0]);
            expect(failures).toEqual([['a', 'stop a']]);
        });
    }

    it('should not be started after a failed start(), and start again on retry', async () => {
        const { group, components } = setup(['a', 'b']);

        components[1]!.startFailure = 'reject';

        await expect(group.start()).rejects.toThrow('start b');
        await group.stop();
        expect(components[0]!.stops).toBe(1);

        group.add('c', new FakeComponent('c', []));

        components[1]!.startFailure = undefined;
        await group.start();
        expect(components.map((c) => c.starts)).toEqual([2, 2]);

        await group.stop();
        expect(components.map((c) => c.stops)).toEqual([2, 1]);
    });

    it('should throw on add() with a duplicate name', () => {
        const { group } = setup(['a']);

        expect(() => group.add('a', new FakeComponent('a', []))).toThrow(/a/);
    });

    it('should throw on add() while started or starting, and accept it after stop()', async () => {
        const { group, components } = setup(['a']);
        const gate = Promise.withResolvers<void>();

        components[0]!.startGate = gate.promise;

        const started = group.start();

        expect(() => group.add('b', new FakeComponent('b', []))).toThrow();

        gate.resolve();
        await started;
        expect(() => group.add('b', new FakeComponent('b', []))).toThrow();

        await group.stop();
        expect(() => group.add('b', new FakeComponent('b', []))).not.toThrow();
    });

    it('should report each component status by name in add order, nested groups included', () => {
        const log: string[] = [];
        const inner = defineComponentGroup();
        const x = new FakeComponent('x', log);

        x.statusValue = { lastSuccessAt: 1 };
        inner.add('x', x);

        const outer = defineComponentGroup();
        const a = new FakeComponent('a', log);

        a.statusValue = { runningSince: 2 };
        outer.add('a', a);
        outer.add('inner', inner);

        expect(outer.status()).toEqual({
            components: [
                { name: 'a', runningSince: 2 },
                {
                    name: 'inner',
                    components: [{ name: 'x', lastSuccessAt: 1 }],
                },
            ],
        });
    });

    it('should start and stop nested groups', async () => {
        const log: string[] = [];
        const inner = defineComponentGroup();

        inner.add('x', new FakeComponent('x', log));

        const outer = defineComponentGroup();

        outer.add('a', new FakeComponent('a', log));
        outer.add('inner', inner);

        await outer.start();
        expect(log).toEqual(['start:a', 'start-done:a', 'start:x', 'start-done:x']);

        log.length = 0;
        await outer.stop();

        // the inner group settles x within its own stop(), and again when the outer group settles it
        expect(log.filter((entry) => entry.startsWith('stop:'))).toEqual(['stop:a', 'stop:x']);
        expect(log.indexOf('stop-done:x')).toBeLessThan(log.indexOf('settled:a'));
        expect(log.filter((entry) => entry === 'settled-done:x')).toHaveLength(2);
        expect(log).toContain('settled-done:a');
    });
});
