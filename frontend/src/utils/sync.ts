/**
 * Deciding whose version of an element survives.
 *
 * Two people draw on the same board at once, so the same element arrives twice
 * with different contents and something has to choose. The rule has to be the
 * same rule on both machines: if one client prefers the incoming element and
 * the other prefers its own, the two boards quietly stop matching and nobody
 * finds out until someone reloads.
 */

const toFiniteNumber = (value: any): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const getVersion = (element: any) => element?.version ?? 0;
const getVersionNonce = (element: any) => element?.versionNonce ?? 0;
const getUpdated = (element: any) => {
  const value = element?.updated;
  return typeof value === "number" ? value : Number(value) || 0;
};

/**
 * A fingerprint of what an element looks like.
 *
 * Only consulted when the bookkeeping fields say the two are the same element
 * at the same revision — which happens during live dragging, where frames are
 * broadcast without bumping the version. It has to name every property a
 * person can change without moving anything, or that change is invisible here
 * and never crosses to the other screen. Colour and font size are two such
 * properties; so is the note metadata a sticky note carries.
 */
export const elementContentSignature = (element: any): string => {
  if (!element || typeof element !== "object") return "";

  const str = (value: any) => (typeof value === "string" ? value : "");
  const text = str(element.text);
  const textSig = text ? `t${text.length}:${text.slice(0, 64)}` : "";

  let pointsSig = "";
  if (Array.isArray(element.points)) {
    const points = element.points as any[];
    const last = points.length > 0 ? points[points.length - 1] : null;
    const lastX = Array.isArray(last) ? toFiniteNumber(last[0]) : 0;
    const lastY = Array.isArray(last) ? toFiniteNumber(last[1]) : 0;
    pointsSig = `p${points.length}:${lastX},${lastY}`;
  }

  // Bounded on purpose: customData is free-form and arrives from other people.
  let customSig = "";
  if (element.customData && typeof element.customData === "object") {
    try {
      customSig = JSON.stringify(element.customData).slice(0, 256);
    } catch {
      customSig = "unserialisable";
    }
  }

  return [
    str(element.type),
    element.isDeleted ? "1" : "0",
    str(element.status),
    toFiniteNumber(element.x),
    toFiniteNumber(element.y),
    toFiniteNumber(element.width),
    toFiniteNumber(element.height),
    toFiniteNumber(element.angle),
    pointsSig,
    str(element.fileId),
    textSig,
    toFiniteNumber(element.fontSize),
    str(element.backgroundColor),
    str(element.strokeColor),
    customSig,
  ].join("|");
};

export type ReconcileOptions = {
  /**
   * Elements this client is in the middle of changing.
   *
   * Somebody typing into a note holds the truth about that note until they
   * stop. Without this, a stale copy arriving from another screen overwrites
   * the sentence being typed — including the copy this client itself sent a
   * moment earlier and is about to supersede.
   */
  protect?: ReadonlySet<string> | null;
};

// Not `SceneCapability.rebaseOntoServer()` in capabilities.ts/adapter.ts -- that method
// always reports unsupported today. This is the live element-merge, called directly from
// useEditorPersistence.ts and pages/editor/shared.ts.
export const reconcileElements = (
  localElements: readonly any[],
  remoteElements: readonly any[],
  options?: ReconcileOptions,
): any[] => {
  const localMap = new Map<string, any>();
  localElements.forEach((el) => {
    localMap.set(el.id, el);
  });

  const protect = options?.protect ?? null;

  remoteElements.forEach((remoteEl) => {
    const localEl = localMap.get(remoteEl.id);

    if (!localEl) {
      localMap.set(remoteEl.id, remoteEl);
      return;
    }

    // Being edited here right now: nothing from outside may land on it.
    if (protect?.has(remoteEl.id)) return;

    const remoteVersion = getVersion(remoteEl);
    const localVersion = getVersion(localEl);

    if (remoteVersion > localVersion) {
      localMap.set(remoteEl.id, remoteEl);
      return;
    }
    if (remoteVersion < localVersion) return;

    const remoteUpdated = getUpdated(remoteEl);
    const localUpdated = getUpdated(localEl);

    if (remoteUpdated > localUpdated) {
      localMap.set(remoteEl.id, remoteEl);
      return;
    }
    if (remoteUpdated < localUpdated) return;

    const remoteNonce = getVersionNonce(remoteEl);
    const localNonce = getVersionNonce(localEl);

    if (remoteNonce !== localNonce) {
      // Same revision, edited on two machines at once. The lower nonce wins —
      // not because it is better, but because both machines compute the same
      // answer from it. The rule this replaced took the remote element every
      // time, which meant each side adopted the other's and the boards drifted
      // apart.
      if (remoteNonce < localNonce) localMap.set(remoteEl.id, remoteEl);
      return;
    }

    // Bookkeeping identical but the contents differ: a live frame from a drag,
    // which is broadcast without bumping anything.
    if (elementContentSignature(remoteEl) !== elementContentSignature(localEl)) {
      localMap.set(remoteEl.id, remoteEl);
    }
  });

  return Array.from(localMap.values());
};

export const applyElementOrder = (
  elements: readonly any[],
  elementOrder: readonly string[] | undefined | null,
): any[] => {
  if (!Array.isArray(elementOrder) || elementOrder.length === 0) return [...elements];

  const byId = new Map<string, any>();
  for (const el of elements) {
    if (el && typeof el.id === "string") byId.set(el.id, el);
  }

  const ordered: any[] = [];
  const seen = new Set<string>();

  for (const id of elementOrder) {
    // Once each. An ordering that names the same element twice is malformed,
    // and honouring it turned a small payload into a huge scene: 20,000 short
    // ids all pointing at one element became 20,000 entries here.
    if (seen.has(id)) continue;
    const el = byId.get(id);
    if (!el) continue;
    ordered.push(el);
    seen.add(id);
  }

  // Preserve any elements not mentioned in the remote ordering (e.g. local-only elements)
  // by appending them in their existing order.
  for (const el of elements) {
    const id = el?.id;
    if (typeof id !== "string") continue;
    if (seen.has(id)) continue;
    ordered.push(el);
  }

  return ordered;
};
