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

/**
 * KV access available to plugin routes (subset we rely on).
 *
 * The compareAndSet/getVersioned/compareAndDelete trio is emdash's ATOMIC
 * KV primitive set (verified against emdash 1.2.0 dist, OptionsRepository):
 *   - compareAndSet(key, null, v)  → INSERT … ON CONFLICT DO NOTHING
 *     (database-atomic exclusive creation)
 *   - compareAndSet(key, rev, v)   → UPDATE … WHERE revision = rev
 *     (database-atomic compare-and-swap)
 *   - compareAndDelete(key, rev)   → DELETE … WHERE revision = rev
 *
 * They are OPTIONAL here: unit tests and exotic runtimes may provide only
 * the plain get/set/delete subset, in which case the refund lock and the
 * rate limiter degrade to their documented best-effort fallbacks.
 */
export interface PluginKV {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	/** Atomic compare-and-swap. Returns {applied, revision?} (emdash shape). */
	compareAndSet?(
		key: string,
		expectedRevision: string | null,
		value: unknown,
	): Promise<{ applied: boolean; revision?: string }>;
	/** Atomic conditional delete. Returns {applied} (emdash shape). */
	compareAndDelete?(
		key: string,
		expectedRevision: string,
	): Promise<{ applied: boolean }>;
	/** Read with revision for CAS loops. Returns {value, revision} or null. */
	getVersioned?(key: string): Promise<{ value: unknown; revision: string } | null>;
	/**
	 * List entries under a key prefix. Returns {key, value}[] where key is
	 * plugin-relative (the emdash namespace prefix is already stripped).
	 * Verified against emdash 1.2.0 dist (context-CvhgHgSH.mjs list()).
	 */
	list?(keyPrefix: string): Promise<{ key: string; value: unknown }[]>;
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
