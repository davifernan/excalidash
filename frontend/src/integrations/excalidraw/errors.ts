/**
 * Failure model for the Excalidraw compatibility layer.
 *
 * A fallback is an expected outcome, not an exception. Capabilities therefore
 * return a result instead of throwing. The consequence is that a non-ok result
 * is invisible outside its caller, which matters most for `editor-changed` --
 * the code that means "an upgrade broke a seam, at a real user". The
 * diagnostics sink in ./compatibility/diagnostics exists for exactly that.
 */

export type CapabilityErrorCode =
  /** The installed Excalidraw build does not offer this seam at all. */
  | "unsupported"
  /** The host has not mounted yet, or the API handle is not attached. */
  | "not-ready"
  /** The caller asked for something the current scene state cannot satisfy. */
  | "invalid-state"
  /** The seam exists but no longer behaves as the contract expects. */
  | "editor-changed";

export type CapabilityFallback = "main-menu" | "manual-selection" | "static-widget";

export type CapabilityFailure = {
  ok: false;
  code: CapabilityErrorCode;
  /** Which capability and operation failed, e.g. "scene.appendElements". */
  seam: string;
  /** Developer-facing detail. Never contains board content or user identity. */
  detail?: string;
  fallback?: CapabilityFallback;
};

export type CapabilityResult<T> = { ok: true; value: T } | CapabilityFailure;

export const ok = <T>(value: T): CapabilityResult<T> => ({ ok: true, value });

export const fail = (
  code: CapabilityErrorCode,
  seam: string,
  options: { detail?: string; fallback?: CapabilityFallback } = {},
): CapabilityFailure => ({ ok: false, code, seam, ...options });

/** Narrowing helper so consumers do not re-implement the check. */
export const isOk = <T>(result: CapabilityResult<T>): result is { ok: true; value: T } => result.ok;

/**
 * Unwrap with an explicit default. Consumers that genuinely have nothing to do
 * on failure use this instead of ignoring the result, so the failure still
 * reaches the diagnostics sink through the capability that produced it.
 */
export const valueOr = <T>(result: CapabilityResult<T>, fallbackValue: T): T =>
  result.ok ? result.value : fallbackValue;
