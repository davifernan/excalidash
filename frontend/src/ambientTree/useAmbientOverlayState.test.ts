import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAmbientOverlayState } from "./useAmbientOverlayState";
import { withExcalidashData } from "../integrations/excalidraw/customData";
import type { ElementId, ElementSummary } from "../integrations/excalidraw/types";

const summary = (over: Partial<ElementSummary> = {}): ElementSummary => ({
  id: "e1" as ElementId,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  angle: 0,
  opacity: 100,
  isDeleted: false,
  frameId: null,
  containerId: null,
  link: null,
  customData: null,
  name: null,
  boundElements: null,
  startBinding: null,
  endBinding: null,
  ...over,
});

const arrow = (
  id: string,
  startId: string | null,
  endId: string | null,
  over: Partial<ElementSummary> = {},
): ElementSummary =>
  summary({
    id: id as ElementId,
    type: "arrow",
    startBinding: startId ? { elementId: startId as ElementId } : null,
    endBinding: endId ? { elementId: endId as ElementId } : null,
    ...over,
  });

const node = (
  id: string,
  x: number,
  y: number,
  over: Partial<ElementSummary> = {},
): ElementSummary => summary({ id: id as ElementId, x, y, ...over });

const collapsedNode = (id: string, x: number, y: number): ElementSummary =>
  node(id, x, y, { customData: withExcalidashData(null, { nodeState: { collapsed: true } }) });

const pinnedNode = (id: string, x: number, y: number): ElementSummary =>
  node(id, x, y, { customData: withExcalidashData(null, { nodeState: { pinned: true } }) });

const HOST_RECT = { left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000 };
const CONTAINER = { getBoundingClientRect: () => HOST_RECT } as unknown as HTMLElement;

const VIEWPORT_OK = {
  ok: true as const,
  value: {
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
    offsetLeft: 0,
    offsetTop: 0,
    width: 1000,
    height: 1000,
  },
};

const render = (summaries: readonly ElementSummary[], container: HTMLElement | null = CONTAINER) =>
  renderHook(() =>
    useAmbientOverlayState({
      container,
      scene: { summaries: () => ({ ok: true, value: summaries }) },
      viewport: { read: () => VIEWPORT_OK },
    }),
  );

describe("useAmbientOverlayState", () => {
  it("starts empty before any onSceneChange tick", () => {
    const { result } = render([]);
    expect(result.current.state).toEqual({ masks: [], collapseBadges: [], pinBadges: [] });
  });

  it("computes masks/badges for a collapsed node on the first tick -- no prior render needed", () => {
    const summaries = [
      collapsedNode("root", 0, 0),
      node("child", 300, 0),
      arrow("e1", "root", "child"),
    ];
    const { result } = render(summaries);
    act(() => result.current.onSceneChange());
    expect(result.current.state.collapseBadges).toHaveLength(1);
    expect(result.current.state.collapseBadges[0].nodeId).toBe("root");
    expect(result.current.state.masks.length).toBeGreaterThan(0);
  });

  it("computes a pin badge for a pinned node", () => {
    const { result } = render([pinnedNode("a", 0, 0)]);
    act(() => result.current.onSceneChange());
    expect(result.current.state.pinBadges).toEqual([{ nodeId: "a", left: -8, top: -8 }]);
  });

  /**
   * NIL-598's own bug: a naive "just re-render" fix would call `setState`
   * on every tick regardless of whether anything changed, reintroducing
   * `useAmbientNodeToolbar.ts`'s own documented "Maximum update depth
   * exceeded" crash. This is the signature gate that avoids it -- proven
   * here by rendering the SAME data twice and confirming `state` is the
   * exact same object reference the second time (React bails out of
   * re-rendering consumers when a memoized/unchanged value is returned).
   */
  it("does not produce a new state object when the computed data is unchanged (the crash-avoidance gate)", () => {
    const summaries = [
      collapsedNode("root", 0, 0),
      node("child", 300, 0),
      arrow("e1", "root", "child"),
    ];
    const { result } = render(summaries);
    act(() => result.current.onSceneChange());
    const first = result.current.state;
    act(() => result.current.onSceneChange());
    expect(result.current.state).toBe(first);
  });

  it("does produce a new state when the underlying data genuinely changes -- proving the gate is not a stuck bail-out", () => {
    let summaries: readonly ElementSummary[] = [node("root", 0, 0), node("child", 300, 0)];
    const { result, rerender } = renderHook(
      ({ data }: { data: readonly ElementSummary[] }) =>
        useAmbientOverlayState({
          container: CONTAINER,
          scene: { summaries: () => ({ ok: true, value: data }) },
          viewport: { read: () => VIEWPORT_OK },
        }),
      { initialProps: { data: summaries } },
    );
    act(() => result.current.onSceneChange());
    expect(result.current.state.collapseBadges).toHaveLength(0);

    summaries = [collapsedNode("root", 0, 0), node("child", 300, 0), arrow("e1", "root", "child")];
    rerender({ data: summaries });
    act(() => result.current.onSceneChange());
    expect(result.current.state.collapseBadges).toHaveLength(1);
  });

  it("resets to empty when there is no container", () => {
    const { result } = render([collapsedNode("root", 0, 0)], null);
    act(() => result.current.onSceneChange());
    expect(result.current.state).toEqual({ masks: [], collapseBadges: [], pinBadges: [] });
  });
});
