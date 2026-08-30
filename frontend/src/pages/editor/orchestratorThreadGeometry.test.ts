import { describe, expect, it } from "vitest";
import {
  activateClusterMember,
  clusterThreadAnchors,
  computeCoordinationBackpressure,
  computeOffscreenThreadLocators,
  resolveOpenThreadPanel,
  selectOpenThread,
  type ProjectedThreadAnchor,
} from "./orchestratorThreadGeometry";

const viewport = { width: 1200, height: 760 };

const anchor = (
  threadId: string,
  rect: { left: number; top: number; right: number; bottom: number },
  elementId = `element-${threadId}`,
): ProjectedThreadAnchor => ({
  threadId,
  elementId,
  title: `Thread ${threadId}`,
  rect,
});

describe("orchestrator thread view state", () => {
  it("enforces one fully open panel per user", () => {
    expect(selectOpenThread(null, "alpha")).toBe("alpha");
    expect(selectOpenThread("alpha", "beta")).toBe("beta");
    expect(selectOpenThread("beta", "beta")).toBeNull();
  });

  it("uses the anchored state while the board anchor is readable", () => {
    const result = resolveOpenThreadPanel({
      anchor: anchor("alpha", { left: 220, top: 180, right: 460, bottom: 340 }),
      viewport,
      previousMode: "closed",
    });

    expect(result.mode).toBe("anchored");
    expect(result.panelRect).not.toBeNull();
    expect(result.direction).toBeNull();
  });

  it("uses the docked state when the open anchor is outside the viewport", () => {
    const result = resolveOpenThreadPanel({
      anchor: anchor("alpha", { left: 1500, top: 180, right: 1740, bottom: 340 }),
      viewport,
      previousMode: "anchored",
    });

    expect(result.mode).toBe("docked");
    expect(result.direction).toBe("right");
    expect(result.distance).toBeGreaterThan(0);
  });

  it("docks when no anchored placement clears visible editor chrome", () => {
    const result = resolveOpenThreadPanel({
      anchor: anchor("alpha", { left: 220, top: 180, right: 460, bottom: 340 }),
      viewport,
      previousMode: "anchored",
      obstacles: [{ left: 0, top: 0, right: 1200, bottom: 760 }],
    });

    expect(result.mode).toBe("docked");
  });

  it("keeps the dock reachable in a narrow viewport", () => {
    const result = resolveOpenThreadPanel({
      anchor: anchor("alpha", { left: 500, top: 100, right: 760, bottom: 256 }),
      viewport: { width: 320, height: 480 },
      previousMode: "anchored",
    });

    expect(result.mode).toBe("docked");
    expect(result.panelRect.left).toBeGreaterThanOrEqual(0);
    expect(result.panelRect.right).toBeLessThanOrEqual(320);
    expect(result.panelRect.bottom).toBeLessThanOrEqual(480);
  });

  it("does not flicker at the readability boundary", () => {
    const narrow = anchor("alpha", { left: 220, top: 180, right: 388, bottom: 292 });
    expect(
      resolveOpenThreadPanel({ anchor: narrow, viewport, previousMode: "anchored" }).mode,
    ).toBe("anchored");
    expect(resolveOpenThreadPanel({ anchor: narrow, viewport, previousMode: "docked" }).mode).toBe(
      "docked",
    );

    const clearlyReadable = anchor("alpha", { left: 220, top: 180, right: 430, bottom: 320 });
    expect(
      resolveOpenThreadPanel({ anchor: clearlyReadable, viewport, previousMode: "docked" }).mode,
    ).toBe("anchored");
  });
});

describe("visual clustering has no coordination semantics", () => {
  it("keeps duplicated cards with the same thread identity as separate board addresses", () => {
    const clusters = clusterThreadAnchors([
      anchor("alpha", { left: 100, top: 100, right: 300, bottom: 220 }),
      anchor("alpha", { left: 600, top: 100, right: 800, bottom: 220 }, "element-alpha-copy"),
    ]);

    expect(clusters).toHaveLength(2);
    expect(new Set(clusters.map((cluster) => cluster.id))).toHaveLength(2);
    expect(
      clusters.flatMap((cluster) => cluster.members.map((member) => member.elementId)),
    ).toEqual(["element-alpha", "element-alpha-copy"]);
  });

  it("keeps two visually clustered threads as separate navigation targets", () => {
    const clusters = clusterThreadAnchors([
      anchor("alpha", { left: 100, top: 100, right: 300, bottom: 220 }),
      anchor("beta", { left: 180, top: 140, right: 380, bottom: 260 }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toEqual([
      { elementId: "element-alpha", threadId: "alpha" },
      { elementId: "element-beta", threadId: "beta" },
    ]);
    expect(activateClusterMember(clusters[0], "element-alpha")).toEqual({
      kind: "navigate",
      threadId: "alpha",
      elementId: "element-alpha",
    });
    expect(activateClusterMember(clusters[0], "element-beta")).toEqual({
      kind: "navigate",
      threadId: "beta",
      elementId: "element-beta",
    });
    expect(activateClusterMember(clusters[0], "missing")).toBeNull();

    // The visual aggregate owns no Context, Dispatch or Lease effect. Its
    // complete action vocabulary is navigation to one original thread.
    expect(Object.keys(activateClusterMember(clusters[0], "element-alpha")!).sort()).toEqual([
      "elementId",
      "kind",
      "threadId",
    ]);
  });

  it("keeps a twenty-thread offscreen crowd reachable through one directional locator", () => {
    const crowd = Array.from({ length: 20 }, (_, index) =>
      anchor(`thread-${index}`, {
        left: 1500 + index * 20,
        top: 180 + index,
        right: 1720 + index * 20,
        bottom: 320 + index,
      }),
    );
    const locators = computeOffscreenThreadLocators(crowd, viewport);

    expect(locators).toHaveLength(1);
    expect(locators[0].direction).toBe("right");
    expect(locators[0].members).toHaveLength(20);
    expect(new Set(locators[0].members.map((member) => member.threadId))).toEqual(
      new Set(crowd.map((item) => item.threadId)),
    );
    expect(Object.keys(locators[0]).sort()).toEqual(
      ["direction", "id", "left", "members", "top"].sort(),
    );
  });
});

describe("visible saturation backpressure", () => {
  it("depends on occupied board area, not a fixed thread count", () => {
    const sparseTwenty = Array.from({ length: 20 }, (_, index) =>
      anchor(`small-${index}`, {
        left: (index % 10) * 110,
        top: Math.floor(index / 10) * 90,
        right: (index % 10) * 110 + 40,
        bottom: Math.floor(index / 10) * 90 + 30,
      }),
    );
    expect(computeCoordinationBackpressure(sparseTwenty, viewport).blocked).toBe(false);

    const visuallySaturated = [
      anchor("wide-a", { left: 0, top: 0, right: 600, bottom: 330 }),
      anchor("wide-b", { left: 600, top: 0, right: 1200, bottom: 330 }),
    ];
    const result = computeCoordinationBackpressure(visuallySaturated, viewport);
    expect(result.blocked).toBe(true);
    expect(result.message).toMatch(/public coordination waits/i);
    expect(result.occupiedRatio).toBeGreaterThan(0.35);
  });

  it("does not count overlapping visual coverage twice", () => {
    const sameAreaTwice = [
      anchor("overlap-a", { left: 0, top: 0, right: 600, bottom: 330 }),
      anchor("overlap-b", { left: 0, top: 0, right: 600, bottom: 330 }),
    ];

    const result = computeCoordinationBackpressure(sameAreaTwice, viewport);
    expect(result.blocked).toBe(false);
    expect(result.occupiedRatio).toBeCloseTo((600 * 330) / (1200 * 760));
  });
});
