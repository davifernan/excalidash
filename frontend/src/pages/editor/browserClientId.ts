/**
 * A stable id for this browser, used only to recognise the same visitor across
 * connections.
 *
 * Presence is keyed by socket, which is right for cursors and wrong for "who is
 * here". A closed tab is not noticed until the socket's ping timeout, so
 * reopening a board within that window listed the same person twice. A signed-in
 * account gives the server a handle to collapse those rows; an anonymous visitor
 * gives it nothing, and this is that nothing filled in.
 *
 * Deliberately weak: it is a display hint the server does not trust for anything
 * else, and losing it (private window, cleared storage) costs only the
 * collapsing, never access.
 */
const STORAGE_KEY = "excalidash:client-id";

const generate = (): string => {
  const cryptoRef = typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  if (cryptoRef?.getRandomValues) cryptoRef.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

let cached: string | null = null;

export const getBrowserClientId = (): string => {
  if (cached) return cached;
  // Storage throws outright in some contexts rather than returning null, and a
  // presence hint is never worth failing a board join over.
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) {
      cached = stored;
      return cached;
    }
  } catch {
    // Ignore: fall through to a per-session value.
  }
  const fresh = generate();
  try {
    window.localStorage.setItem(STORAGE_KEY, fresh);
  } catch {
    // Ignore: a value that lives only for this page is still better than none.
  }
  cached = fresh;
  return fresh;
};
