const MEBIBYTE = 1024 * 1024;

/**
 * Canonical limits for one live scene update and its enclosing transport.
 *
 * Each inner ceiling is deliberately below the next one. That ordering gives
 * the application room to reject an oversized event with an acknowledgement
 * before Socket.IO reaches its transport ceiling and closes the connection.
 */
export const SOCKET_LIMITS = {
  drawingIdLength: 200,
  coordinateAbs: 1_000_000_000,
  viewportSpan: 100_000_000,
  elementsPerUpdate: 10_000,
  filesPerUpdate: 1_000,
  elementOrderBytes: 8 * MEBIBYTE,
  elementBytes: 512 * 1024,
  fileDataUrlLength: 10 * MEBIBYTE,
  fileBytes: 10 * MEBIBYTE + 4 * 1024,
  // Client batching must target this ceiling. It sits above one complete file but
  // leaves room for the event envelope, other elements, and transport framing.
  clientElementUpdateBytes: 11 * MEBIBYTE,
  // Guests have a smaller per-event ceiling than signed-in collaborators, but
  // it still carries one maximum client batch and is below the general parser.
  anonymousElementUpdateBytes: 13 * MEBIBYTE,
  elementUpdateBytes: 15 * MEBIBYTE,
} as const;

export const DEFAULT_SOCKET_MAX_HTTP_BUFFER_BYTES = 16 * MEBIBYTE;

export type ElementUpdateTrafficLimits = {
  accountBytesPerWindow: number;
  anonymousBytesPerWindow: number;
  accountActorBytesPerWindow: number;
  anonymousActorBytesPerWindow: number;
  windowMs: number;
};

export const ELEMENT_UPDATE_TRAFFIC_LIMITS: ElementUpdateTrafficLimits = {
  // Every board budget exceeds the transport ceiling, so one valid transport
  // frame can always reach the application and receive a structured answer.
  accountBytesPerWindow: 30 * MEBIBYTE,
  anonymousBytesPerWindow: 20 * MEBIBYTE,
  // Four ordinary board budgets fit under each actor-wide ceiling. Opening
  // more boards therefore cannot multiply aggregate relay traffic forever.
  accountActorBytesPerWindow: 120 * MEBIBYTE,
  anonymousActorBytesPerWindow: 80 * MEBIBYTE,
  windowMs: 1_000,
};

export const assertSocketLimitContract = (
  transportBytes = DEFAULT_SOCKET_MAX_HTTP_BUFFER_BYTES,
): void => {
  const orderedLimits = [
    ["file envelope", SOCKET_LIMITS.fileBytes],
    ["client update target", SOCKET_LIMITS.clientElementUpdateBytes],
    ["anonymous event", SOCKET_LIMITS.anonymousElementUpdateBytes],
    ["event parser", SOCKET_LIMITS.elementUpdateBytes],
    ["Socket.IO transport", transportBytes],
    ["anonymous board budget", ELEMENT_UPDATE_TRAFFIC_LIMITS.anonymousBytesPerWindow],
    ["account board budget", ELEMENT_UPDATE_TRAFFIC_LIMITS.accountBytesPerWindow],
  ] as const;

  for (let index = 1; index < orderedLimits.length; index += 1) {
    const [lowerName, lowerBytes] = orderedLimits[index - 1];
    const [upperName, upperBytes] = orderedLimits[index];
    if (!Number.isSafeInteger(upperBytes) || lowerBytes >= upperBytes) {
      throw new Error(
        `Invalid socket limit contract: ${lowerName} (${lowerBytes}) must be below ${upperName} (${upperBytes}).`,
      );
    }
  }

  const actorRelationships = [
    [
      "anonymous",
      ELEMENT_UPDATE_TRAFFIC_LIMITS.anonymousBytesPerWindow,
      ELEMENT_UPDATE_TRAFFIC_LIMITS.anonymousActorBytesPerWindow,
    ],
    [
      "account",
      ELEMENT_UPDATE_TRAFFIC_LIMITS.accountBytesPerWindow,
      ELEMENT_UPDATE_TRAFFIC_LIMITS.accountActorBytesPerWindow,
    ],
  ] as const;
  for (const [actor, boardBytes, actorBytes] of actorRelationships) {
    if (actorBytes < boardBytes * 4) {
      throw new Error(
        `Invalid socket limit contract: ${actor} actor budget (${actorBytes}) must hold four board budgets (${boardBytes}).`,
      );
    }
  }
};

assertSocketLimitContract();
