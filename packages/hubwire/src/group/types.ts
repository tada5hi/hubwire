import type { ComponentStatus, IComponent, NamedComponentStatus } from '../component';

/**
 * Observers; a hook that throws is ignored (see invokeHook).
 */
export type ComponentGroupHooks = {
    /**
     * A component's stop() or settled() threw or rejected during a stop sweep
     * (stop(), or the cleanup of a failed start()). The others are stopped and settled anyway.
     */
    onStopFailed?(name: string, error: unknown): void,
};

export type ComponentGroupOptions = {
    hooks?: ComponentGroupHooks,
};

/**
 * The group's own lastSuccessAt / runningSince are never set: hubwire aggregates nothing,
 * each component reports its own status under its name, in add order. ComponentStatus
 * with `components` required: through an IComponent the same list is `status().components?`.
 */
export type ComponentGroupStatus = ComponentStatus & {
    components: NamedComponentStatus[],
};

/**
 * Named components started in add order and stopped as one: stop() on all (reverse order),
 * then settled?.() on all. A group is an IComponent itself, so groups nest.
 */
export interface IComponentGroup extends IComponent {
    /**
     * Throws on a duplicate name, and while the group is starting, started or stopping.
     */
    add(name: string, component: IComponent): void;
    /**
     * Starts the components in add order, one at a time. If one fails, stops and settles
     * those already started, then rejects with that error; start() can be retried.
     * A start() while started does nothing; a start() in flight is joined.
     */
    start(): Promise<void>;
    /**
     * Never rejects; a component that fails to stop or settle is reported to `onStopFailed`.
     * Does nothing when not started. During a start() in flight it stops the component being
     * started at once (its start() may wait for that), starts none after it, then waits for the start().
     */
    stop(): Promise<void>;
    status(): ComponentGroupStatus;
    /**
     * Never set: a group handles no events, so it fits an IComponent of any event map.
     */
    handle?: undefined;
    /**
     * Resolves once every component's settled?.() resolved or failed. Never rejects.
     */
    settled(): Promise<void>;
}
