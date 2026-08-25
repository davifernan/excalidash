import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useOffscreenPresence } from "./useOffscreenPresence";
import { ok } from "../../integrations/excalidraw/errors";
import type { ExcalidrawAdapter } from "../../integrations/excalidraw/capabilities";
import type { CollaboratorInfo, SocketId } from "../../integrations/excalidraw/types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const collaborator = (overrides: Partial<CollaboratorInfo> = {}): CollaboratorInfo => ({
  socketId: "peer-1" as SocketId,
  name: "Ada",
  avatarUrl: null,
  pointer: { x: 0, y: 0 },
  selectedIds: [],
  selectionAllSelected: false,
  color: "#ff0000",
  pointerButton: "up",
  isSelf: false,
  ...overrides,
});

const makeAdapter = (root: HTMLElement, collaborators: CollaboratorInfo[]): ExcalidrawAdapter => {
  const size = { width: 1000, height: 600 };
  return {
    ui: { overlayRoot: () => ok(root) },
    viewport: {
      read: () =>
        ok({
          zoom: 1,
          scrollX: 0,
          scrollY: 0,
          offsetLeft: 0,
          offsetTop: 0,
          ...size,
        }),
      // Identity projection is enough here: the geometry itself is covered
      // by offscreenPresenceGeometry.test.ts.
      toViewport: (point: { x: number; y: number }) => ok(point),
      subscribeScroll: () => () => {},
      visibleBounds: () => ok([0, 0, size.width, size.height] as const),
      showBounds: () =>
        ok({
          viewport: { zoom: 1, scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0, ...size },
          bounds: [0, 0, size.width, size.height] as const,
          zoomClamped: false,
        }),
      scrollToElement: () =>
        ok({
          viewport: { zoom: 1, scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0, ...size },
          bounds: [0, 0, size.width, size.height] as const,
          zoomClamped: false,
        }),
      toScene: (point: { x: number; y: number }) => ok(point),
    },
    collaboration: {
      readCollaborators: () => ok(collaborators),
      patchCollaborators: () => ok(undefined),
      removeCollaborators: () => ok(undefined),
      readFollowState: () => ok({ followingSocketId: null, followedBySocketIds: [] }),
      follow: () => ok(undefined),
      setFollowedBy: () => ok(undefined),
      onFollowIntent: () => () => {},
      onLocalPointerBroadcast: () => () => {},
    },
  } as unknown as ExcalidrawAdapter;
};

const Harness: React.FC<{ adapter: ExcalidrawAdapter }> = ({ adapter }) => {
  const { offscreenPresenceOverlay } = useOffscreenPresence({ adapter });
  return <>{offscreenPresenceOverlay}</>;
};

describe("useOffscreenPresence", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
  });

  it("shows nothing while every collaborator is inside the viewport", () => {
    const adapter = makeAdapter(root, [collaborator({ pointer: { x: 500, y: 300 } })]);
    render(<Harness adapter={adapter} />);
    expect(screen.queryByTestId("offscreen-presence-marker")).toBeNull();
  });

  it("skips self even when self's pointer is offscreen", () => {
    const adapter = makeAdapter(root, [
      collaborator({ pointer: { x: 5000, y: 300 }, isSelf: true }),
    ]);
    render(<Harness adapter={adapter} />);
    expect(screen.queryByTestId("offscreen-presence-marker")).toBeNull();
  });

  it("shows a marker for a remote collaborator outside the viewport", () => {
    const adapter = makeAdapter(root, [collaborator({ pointer: { x: 5000, y: 300 } })]);
    render(<Harness adapter={adapter} />);
    expect(screen.getAllByTestId("offscreen-presence-marker")).toHaveLength(1);
  });

  it("polls so a collaborator arriving later still appears without a remount", async () => {
    vi.useFakeTimers();
    const collaborators: CollaboratorInfo[] = [];
    const adapter = makeAdapter(root, collaborators);
    render(<Harness adapter={adapter} />);
    expect(screen.queryByTestId("offscreen-presence-marker")).toBeNull();

    collaborators.push(collaborator({ pointer: { x: 5000, y: 300 } }));
    await vi.advanceTimersByTimeAsync(300);

    expect(screen.getAllByTestId("offscreen-presence-marker")).toHaveLength(1);
  });
});
