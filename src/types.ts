/**
 * Shared types for the Mercado Pago wrapper plugin.
 *
 * The emdash route context for a native plugin route: the single ctx object
 * passed to the handler is both the route context (request, input, user,
 * requestMeta) and the plugin context (kv, http, log, storage, content, …).
 * The core's authored handlers use `(routeCtx, ctx)` and emdash's
 * `toNativeRoutes` passes the one ctx as both arguments.
 *
 * We keep this intentionally structural (no imports from emdash internals)
 * so the wrapper compiles against the public surface only.
 */

/** KV access available to plugin routes (subset we rely on). */
export interface PluginKV {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
}

/** Sandboxed HTTP access (host-allowlisted fetch). */
export interface PluginHTTP {
	fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** Logger that never logs secrets (emdash redacts via secretRedactor). */
export interface PluginLog {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

/** The single ctx object emdash hands to native route handlers. */
export interface PluginRouteContext {
	request: Request;
	input?: unknown;
	user?: unknown;
	requestMeta?: unknown;
	kv: PluginKV;
	http?: PluginHTTP;
	log: PluginLog;
	storage?: unknown;
}
