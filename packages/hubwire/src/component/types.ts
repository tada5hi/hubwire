import type { IClock } from '../clock';
import type { ObjectLiteral } from '../types';

export type ComponentMetadata = {
    correlationId?: string,
    [key: string]: unknown,
};

export type ComponentEventMapValue = [ObjectLiteral, ComponentMetadata];
export type ComponentEventMap = Record<string, ComponentEventMapValue>;

export type ComponentOptions = {
    /**
     * Where status() times come from. Default: systemClock
     */
    clock?: IClock,
};

export type ComponentStatus = {
    /**
     * Epoch ms the last pass / handled call that completed without error ended.
     */
    lastSuccessAt?: number,
    /**
     * Epoch ms the last pass / handled call that failed ended.
     */
    lastErrorAt?: number,
    /**
     * Epoch ms the last pass / handled call ended, however it ended.
     */
    lastRunAt?: number,
    /**
     * Epoch ms the pass / call in flight started at.
     */
    runningSince?: number,
};

export type ComponentHandlerContext<
    EventMap extends ComponentEventMap = ComponentEventMap,
    K extends keyof EventMap & string = keyof EventMap & string,
> = {
    key: K,
    metadata: EventMap[K][1],
    handle<C extends keyof EventMap & string>(key: C, data: EventMap[C][0], metadata?: EventMap[C][1]): Promise<void>,
};

export type ComponentHandlerFn<
    EventMap extends ComponentEventMap = ComponentEventMap,
    K extends keyof EventMap & string = keyof EventMap & string,
> = (data: EventMap[K][0], context: ComponentHandlerContext<EventMap, K>) => Promise<void> | void;

export type ComponentHandler<
    EventMap extends ComponentEventMap = ComponentEventMap,
    K extends keyof EventMap & string = keyof EventMap & string,
> = {
    initialize?: () => Promise<void> | void,
    handle: ComponentHandlerFn<EventMap, K>,
};

export type ComponentHandleOptions<EventMap extends ComponentEventMap = ComponentEventMap> = {
    /**
     * Receives every event no handler (and no '*') accepted — the replies.
     */
    handle?(data: EventMap[keyof EventMap & string][0], context: ComponentHandlerContext<EventMap>): Promise<void> | void,
};

export interface IComponent<EventMap extends ComponentEventMap = ComponentEventMap> {
    start(): Promise<void>;
    stop(): Promise<void>;
    status(): ComponentStatus;
    /**
     * Resolves once no work started by this component is still running. Optional:
     * a shutdown over mixed components stops them all, then awaits `settled?.()`.
     */
    settled?(): Promise<void>;
    handle?<K extends keyof EventMap & string>(
        key: K,
        data: EventMap[K][0],
        metadata?: EventMap[K][1],
        options?: ComponentHandleOptions<EventMap>,
    ): Promise<void>;
}

/**
 * A component that can be called: an IComponent whose handle is not optional.
 * Component satisfies it.
 */
export interface ICallable<EventMap extends ComponentEventMap = ComponentEventMap> extends IComponent<EventMap> {
    handle: NonNullable<IComponent<EventMap>['handle']>;
}

/**
 * One event a component did not handle — a child event (a reply) or an
 * unknown top-level command — typed by key.
 */
export type ForwardedEvent<EventMap extends ComponentEventMap = ComponentEventMap> = {
    [K in keyof EventMap & string]: {
        key: K,
        data: EventMap[K][0],
        metadata: EventMap[K][1]
    }
}[keyof EventMap & string];

/**
 * Which pass of which scheduled component a hook reports.
 */
export type ScheduledComponentHookContext = {
    /**
     * The tick's planned fire time; for the start pass, the time start() ran it.
     */
    scheduledAt: Date,
    /**
     * The component's `name` option.
     */
    name?: string,
};

/**
 * Why a tick did not run: another replica holds its lock (`locked`), its timer
 * fired lockTtlMs or more late (`late`), or a pass was still running (`running`).
 */
export type ScheduledComponentSkipReason = 'locked' | 'late' | 'running';

export type ScheduledComponentSkipContext = ScheduledComponentHookContext & {
    reason: ScheduledComponentSkipReason,
};

/**
 * Observers; a hook that throws is ignored (see invokeHook).
 */
export type ScheduledComponentHooks = {
    /**
     * A pass failed, or the lock's acquire() rejected (the tick is skipped, the status unchanged).
     * start() still resolves; the next tick runs again.
     */
    onError?(error: unknown, context: ScheduledComponentHookContext): void,
    /**
     * A tick was skipped; `context.reason` says why.
     */
    onSkip?(scheduledAt: Date, context: ScheduledComponentSkipContext): void,
};

/**
 * A component that can be drained: an IComponent whose settled is not optional.
 */
export interface IScheduledComponent extends IComponent {
    /**
     * Resolves once no pass is running (at once when none is). stop() does not
     * wait for a pass in flight; a shutdown awaits settled() after stop().
     * A pass must never await its own component's settled(): it would wait for itself.
     */
    settled(): Promise<void>;
}

/**
 * Elects one replica per tick. Every implementation keeps this contract:
 * the first caller for a key wins, atomically across callers and replicas;
 * the key stays held until `ttlMs` elapsed (free at exactly acquiredAt + ttlMs) and is never
 * released: the key is unique per tick, and a release would let a replica that fires
 * the same tick late win it again. A rejected `acquire` counts as not acquired:
 * the tick is skipped and the error reported.
 */
export interface IScheduleLock {
    /**
     * true when this caller won `key` for `ttlMs`; false while another holds it.
     */
    acquire(key: string, ttlMs: number): Promise<boolean>;
}

export type ScheduledComponentRunContext = {
    /**
     * The planned fire time of the tick (ms 0), also when its timer fires late;
     * for the start pass, the time start() ran it.
     */
    scheduledAt: Date,
    /**
     * Aborted by stop() while the pass runs. The pass may end early; settled() still waits for it.
     */
    signal: AbortSignal,
};

type ScheduledComponentBaseOptions = {
    /**
     * Cron expression with 5 or 6 fields (seconds first), evaluated by croner.
     */
    schedule: string,
    /**
     * One pass. Receives the tick's planned fire time.
     */
    run: (context: ScheduledComponentRunContext) => Promise<void>,
    /**
     * IANA zone the expression is evaluated in, e.g. 'Europe/Berlin'.
     * Default: the process's local zone.
     */
    timezone?: string,
    /**
     * Run one pass in start() before scheduling. The start pass never takes the lock.
     * Default: true without a lock, false with one.
     */
    runOnStart?: boolean,
    hooks?: ScheduledComponentHooks,
    /**
     * Time and timers of the schedule and of status(). Default: systemClock
     */
    clock?: IClock,
    /**
     * unref() every timer the component arms, so a started component does not keep
     * the process alive. Default: false
     */
    unref?: boolean,
};

export type ScheduledComponentOptions = ScheduledComponentBaseOptions & (
    {
        name?: string,
        lock?: undefined,
        lockTtlMs?: undefined,
    } |
    {
        /**
         * Forms the lock key `${name}:${scheduledAt.toISOString()}`, shared by all replicas:
         * unique per schedule among the processes sharing a lock.
         */
        name: string,
        /**
         * Elects one replica per tick: only the one that acquires the tick's key runs it.
         */
        lock: IScheduleLock,
        /**
         * How long a tick's key is held. Must exceed the clock skew between replicas
         * plus how late a replica can fire. Default: 60_000
         */
        lockTtlMs?: number,
    }
);

/**
 * Which interval component a hook reports.
 */
export type IntervalComponentHookContext = {
    /**
     * The component's `name` option.
     */
    name?: string,
};

/**
 * Observers; a hook that throws is ignored (see invokeHook).
 */
export type IntervalComponentHooks = {
    /**
     * A pass threw, rejected or returned an invalid delayMs. The loop waits intervalMs.
     */
    onError?(error: unknown, context: IntervalComponentHookContext): void,
};

export type IntervalComponentHandlerContext = {
    /**
     * Aborted by stop() while the pass runs. The pass may end early; settled() still waits for it.
     */
    signal: AbortSignal,
};

/**
 * What a pass decides about the loop: nothing waits `intervalMs`; `{ delayMs }` waits that
 * long once (a positive finite number, else the pass counts as failed); `{ done: true }`
 * ends the loop, as stop() would, until the next start(). `done` wins over `delayMs`.
 */
export type IntervalResult = void | {
    delayMs?: number,
    done?: boolean,
};

export type IntervalComponentOptions = {
    /**
     * The wait between the end of one pass and the start of the next, in ms. A positive finite number.
     */
    intervalMs: number,
    /**
     * One pass. Its result decides what follows (see IntervalResult).
     */
    handler: (context: IntervalComponentHandlerContext) => Promise<IntervalResult> | IntervalResult,
    /**
     * Names the component for its owner (logs, status pages); passed to the hooks.
     */
    name?: string,
    /**
     * Run one pass in start() before the first wait. Default: false
     */
    runOnStart?: boolean,
    hooks?: IntervalComponentHooks,
    /**
     * Time and timers of the loop and of status(). Default: systemClock
     */
    clock?: IClock,
    /**
     * unref() every timer the component arms, so a started component does not keep
     * the process alive. Default: false
     */
    unref?: boolean,
};
