import type React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawAdapter } from "../../integrations/excalidraw/capabilities";
import {
  readOrchestratorThreadAnchor,
  withExcalidashData,
} from "../../integrations/excalidraw/customData";
import { ok } from "../../integrations/excalidraw/errors";
import type { ElementId, ElementSummary, SceneOp } from "../../integrations/excalidraw/types";
import { useOrchestratorThreadFeature } from "./useOrchestratorThreadFeature";

const viewportState = {
  zoom: 1,
  scrollX: 0,
  scrollY: 0,
  offsetLeft: 0,
  offsetTop: 0,
  width: 1200,
  height: 760,
};

const persistedAnchor = (): ElementSummary => ({
  id: "element-alpha" as ElementId,
  type: "rectangle",
  x: 120,
  y: 90,
  width: 260,
  height: 156,
  angle: 0,
  isDeleted: false,
  frameId: null,
  containerId: null,
  link: null,
  customData: withExcalidashData(
    {},
    { orchestratorThread: { threadId: "alpha", title: "Release coordination" } },
  ),
  name: null,
  boundElements: null,
  startBinding: null,
  endBinding: null,
});

const makeAdapter = (
  root: HTMLElement,
  elements: ElementSummary[],
  apply: (ops: readonly SceneOp[]) => void = () => {},
): ExcalidrawAdapter =>
  ({
    scene: {
      summaries: () => ok(elements),
      subscribe: () => () => {},
      apply: (ops: readonly SceneOp[]) => {
        apply(ops);
        return ok(undefined);
      },
    },
    viewport: {
      read: () => ok(viewportState),
      toViewport: (point: { x: number; y: number }) => ok(point),
      toScene: (point: { x: number; y: number }) => ok(point),
      subscribeScroll: () => () => {},
      scrollToElement: () =>
        ok({ viewport: viewportState, bounds: [0, 0, 1200, 760], zoomClamped: false }),
    },
    ui: { overlayRoot: () => ok(root) },
  }) as unknown as ExcalidrawAdapter;

const Harness: React.FC<{
  adapter: ExcalidrawAdapter;
  canEdit?: boolean;
  isReady?: boolean;
}> = ({ adapter, canEdit = true, isReady = true }) => {
  const { orchestratorThreadOverlay, createThread } = useOrchestratorThreadFeature({
    adapter,
    canEdit,
    isReady,
  });
  return (
    <>
      <button type="button" onClick={createThread}>
        Create
      </button>
      {orchestratorThreadOverlay}
    </>
  );
};

describe("useOrchestratorThreadFeature", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    cleanup();
    root.remove();
  });

  it("discovers the persisted Board Card at the same position after remount", async () => {
    const adapter = makeAdapter(root, [persistedAnchor()]);
    const first = render(<Harness adapter={adapter} />);
    await screen.findByRole("button", { name: "Open Release coordination" });
    const before = screen.getByTestId("orchestrator-thread-card");
    expect(before).toHaveStyle({ left: "120px", top: "90px", width: "260px", height: "156px" });

    first.unmount();
    render(<Harness adapter={adapter} />);
    await screen.findByRole("button", { name: "Open Release coordination" });
    const after = screen.getByTestId("orchestrator-thread-card");
    expect(after).toHaveStyle({ left: "120px", top: "90px", width: "260px", height: "156px" });
  });

  it("subscribes only after the editor handle becomes ready", async () => {
    const adapter = makeAdapter(root, [persistedAnchor()]);
    const rendered = render(<Harness adapter={adapter} isReady={false} />);
    expect(screen.queryByRole("button", { name: "Open Release coordination" })).toBeNull();

    rendered.rerender(<Harness adapter={adapter} isReady />);
    expect(await screen.findByRole("button", { name: "Open Release coordination" })).toBeVisible();
  });

  it("projects a rotated Board Card around its element centre", async () => {
    const rotated = { ...persistedAnchor(), angle: Math.PI / 2 };
    render(<Harness adapter={makeAdapter(root, [rotated])} />);

    await screen.findByRole("button", { name: "Open Release coordination" });
    const style = screen.getByTestId("orchestrator-thread-card").style;
    expect(Number.parseFloat(style.left)).toBeCloseTo(172);
    expect(Number.parseFloat(style.top)).toBeCloseTo(38);
    expect(Number.parseFloat(style.width)).toBeCloseTo(156);
    expect(Number.parseFloat(style.height)).toBeCloseTo(260);
  });

  it("creates and selects one shared anchor in one scene write", async () => {
    const calls: readonly SceneOp[][] = [];
    const adapter = makeAdapter(root, [], (ops) => (calls as SceneOp[][]).push([...ops]));
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-2222-4333-8444-555555555555");
    render(<Harness adapter={adapter} />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].map((op) => op.kind)).toEqual(["insert", "select"]);
    const insert = calls[0][0];
    expect(insert.kind).toBe("insert");
    if (insert.kind !== "insert") throw new Error("expected insert");
    expect(insert.elements).toHaveLength(1);
    // updateScene does not hydrate skeletons. A raw rectangle without the
    // editor's required groupIds/version/seed fields crashes the interactive
    // canvas; construction must go through Excalidraw's element builder.
    expect((insert.elements[0] as unknown as Record<string, unknown>).groupIds).toEqual([]);
    expect((insert.elements[0] as unknown as Record<string, unknown>).seed).toEqual(
      expect.any(Number),
    );
    expect(readOrchestratorThreadAnchor({ customData: insert.elements[0].customData })).toEqual({
      threadId: "11111111-2222-4333-8444-555555555555",
      title: "Orchestrator 1111",
    });
  });

  it("does not create a shared Board Card for a viewer without edit access", () => {
    const apply = vi.fn();
    render(<Harness adapter={makeAdapter(root, [], apply)} canEdit={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not cover a populated board with the empty-board invitation", async () => {
    const ordinaryElement = {
      ...persistedAnchor(),
      id: "ordinary-element" as ElementId,
      customData: null,
    };
    render(<Harness adapter={makeAdapter(root, [ordinaryElement])} />);

    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    expect(screen.queryByTestId("orchestrator-thread-invitation")).toBeNull();
  });
});
