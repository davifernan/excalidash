import type { Socket } from "socket.io-client";
import type { CollaborationCapability } from "../../integrations/excalidraw/capabilities";
import type { CapabilityFailure, CapabilityResult } from "../../integrations/excalidraw/errors";
import type {
  CollaboratorInfo,
  CollaboratorPatch,
  ElementId,
  SocketId,
} from "../../integrations/excalidraw/types";

// This mirrors the server's transport budget so an oversized selection becomes
// the same compact marker before it reaches the socket.
export const REMOTE_SELECTION_LIMITS = { payloadBytes: 256 * 1024 } as const;
const SELECTION_THROTTLE_MS = 50;

type RemoteSelection = { selectedElementIds: string[] } | { allSelected: true };

const LARGE_SELECTION_SUFFIX = " · large selection";

// Keeping the signal in Excalidraw's existing collaborator name makes it
// visible in both the avatar and cursor renderers without inventing element ids.
export const withLargeSelectionStatus = (username: unknown, active: boolean): string => {
  const current = typeof username === "string" && username ? username : "Participant";
  const base = current.endsWith(LARGE_SELECTION_SUFFIX)
    ? current.slice(0, -LARGE_SELECTION_SUFFIX.length)
    : current;
  return active ? `${base}${LARGE_SELECTION_SUFFIX}` : base;
};

const parseRemoteSelectedElementIds = (value: unknown): ElementId[] | null => {
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) {
    return null;
  }
  return value as ElementId[];
};

const selectionForWire = (drawingId: string, ids: readonly string[]): RemoteSelection => {
  const selectedElementIds: string[] = [];
  const encoder = new TextEncoder();
  let payloadBytes = encoder.encode(JSON.stringify({ drawingId, selectedElementIds })).byteLength;
  for (const id of ids) {
    const nextBytes =
      encoder.encode(JSON.stringify(id)).byteLength + (selectedElementIds.length ? 1 : 0);
    if (payloadBytes + nextBytes > REMOTE_SELECTION_LIMITS.payloadBytes) {
      return { allSelected: true };
    }
    selectedElementIds.push(id);
    payloadBytes += nextBytes;
  }
  return { selectedElementIds };
};

export const bindRemoteSelection = ({
  socket,
  drawingId,
  collaboration,
  onCapabilityFailure,
  throttleMs = SELECTION_THROTTLE_MS,
}: {
  socket: Socket;
  drawingId: string;
  collaboration: CollaborationCapability;
  onCapabilityFailure: (failure: CapabilityFailure) => void;
  throttleMs?: number;
}) => {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let lastSentSignature: string | null = null;
  let pendingSelection: RemoteSelection | null = null;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (selection: RemoteSelection) => {
    lastSentAt = Date.now();
    lastSentSignature = JSON.stringify(selection);
    socket.emit("selection-update", { drawingId, ...selection });
  };

  const clearTimer = () => {
    if (sendTimer !== null) clearTimeout(sendTimer);
    sendTimer = null;
  };

  const handle = <T>(result: CapabilityResult<T>): result is { ok: true; value: T } => {
    if (result.ok) return true;
    onCapabilityFailure(result);
    return false;
  };

  const publish = (selectedIds: readonly string[]) => {
    const selection = selectionForWire(drawingId, [...selectedIds].sort());
    const signature = JSON.stringify(selection);
    if (signature === lastSentSignature) {
      pendingSelection = null;
      clearTimer();
      return;
    }
    const remaining = throttleMs - (Date.now() - lastSentAt);
    if (remaining <= 0) {
      pendingSelection = null;
      clearTimer();
      send(selection);
      return;
    }
    pendingSelection = selection;
    if (sendTimer !== null) return;
    sendTimer = setTimeout(() => {
      sendTimer = null;
      const nextSelection = pendingSelection;
      pendingSelection = null;
      if (nextSelection) send(nextSelection);
    }, remaining);
  };

  const patchForSelection = (
    existing: CollaboratorInfo | undefined,
    payload: any,
  ): CollaboratorPatch | null => {
    if (payload?.drawingId !== drawingId || typeof payload?.presenceId !== "string") return null;
    const allSelected = payload.allSelected === true && payload.selectedElementIds === undefined;
    const selectedElementIds = allSelected
      ? []
      : parseRemoteSelectedElementIds(payload.selectedElementIds);
    if (!selectedElementIds) return null;
    return {
      socketId: payload.presenceId as SocketId,
      name: withLargeSelectionStatus(existing?.name, allSelected),
      selectedIds: selectedElementIds,
      selectionAllSelected: allSelected,
    };
  };

  const currentCollaborators = (): Map<string, CollaboratorInfo> | null => {
    const result = collaboration.readCollaborators();
    if (!handle(result)) return null;
    return new Map(
      result.value.map((collaborator) => [String(collaborator.socketId), collaborator]),
    );
  };

  const applyPatches = (patches: readonly CollaboratorPatch[]) => {
    if (patches.length === 0) return;
    handle(collaboration.patchCollaborators(patches));
  };

  const onSelection = (payload: any) => {
    const collaborators = currentCollaborators();
    if (!collaborators) return;
    const patch = patchForSelection(collaborators.get(payload?.presenceId), payload);
    if (patch) applyPatches([patch]);
  };

  const onSnapshot = (payload: any) => {
    if (payload?.drawingId !== drawingId || !Array.isArray(payload?.selections)) return;
    const collaborators = currentCollaborators();
    if (!collaborators) return;
    const patches: CollaboratorPatch[] = [];
    for (const selection of payload.selections) {
      const patch = patchForSelection(collaborators.get(selection?.presenceId), {
        drawingId,
        ...selection,
      });
      if (!patch) continue;
      patches.push(patch);
      const previous = collaborators.get(String(patch.socketId));
      collaborators.set(String(patch.socketId), {
        socketId: patch.socketId,
        name: patch.name ?? previous?.name ?? null,
        avatarUrl: previous?.avatarUrl ?? null,
        pointer: previous?.pointer ?? null,
        selectedIds: patch.selectedIds ?? previous?.selectedIds ?? [],
        selectionAllSelected: patch.selectionAllSelected ?? previous?.selectionAllSelected ?? false,
        // Carried, not decided: this path only writes the selection. Colour,
        // pointer button, pointer tool and the self-flag belong to whoever set
        // them.
        color: previous?.color ?? null,
        pointerButton: previous?.pointerButton ?? null,
        pointerTool: previous?.pointerTool ?? null,
        isSelf: previous?.isSelf ?? false,
      });
    }
    applyPatches(patches);
  };

  const reset = () => {
    clearTimer();
    pendingSelection = null;
    lastSentAt = Number.NEGATIVE_INFINITY;
    lastSentSignature = null;
  };

  socket.on("selection-update", onSelection);
  socket.on("selection-snapshot", onSnapshot);
  return {
    publish,
    reset,
    dispose() {
      reset();
      socket.off("selection-update", onSelection);
      socket.off("selection-snapshot", onSnapshot);
    },
  };
};
