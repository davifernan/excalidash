import { buildElements } from "./elements";
import type { ArrowStyle, BoundElementRef, ElementId } from "./types";

export type BoundBox = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type ScenePoint = { readonly x: number; readonly y: number };

/**
 * Build the editor's ordinary, two-way bound arrow between two existing boxes.
 *
 * The temporary box skeletons are intentional: Excalidraw's supported
 * `start`/`end` shorthand is what produces its native binding metadata. The
 * caller supplies the visible anchors because different gestures connect
 * different edges of the same boxes.
 */
export function createBoundArrow(
  id: string,
  startBox: BoundBox,
  endBox: BoundBox,
  start: ScenePoint,
  end: ScenePoint,
  style: Pick<ArrowStyle, "strokeColor" | "strokeWidth"> & Partial<ArrowStyle>,
): any {
  const [, , arrow] = buildElements(
    [
      { ...startBox, type: "rectangle" },
      { ...endBox, type: "rectangle" },
      {
        id,
        type: "arrow",
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [1, 1],
        ],
        roughness: 0,
        ...style,
        start: { id: startBox.id },
        end: { id: endBox.id },
      },
    ] as any,
    { regenerateIds: false },
  ) as any[];

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // updateScene preserves supplied elbow points; unlike an interactive drag it
  // does not reroute this freshly inserted bound arrow. Seed an orthogonal
  // route ourselves so the elbow choice is visible immediately.
  const points =
    style.elbowed && dx !== 0 && dy !== 0
      ? [
          [0, 0],
          [dx, 0],
          [dx, dy],
        ]
      : [
          [0, 0],
          [dx, dy],
        ];
  return {
    ...arrow,
    index: null,
    x: start.x,
    y: start.y,
    points,
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
}

/** Add arrow refs without discarding a box's labels or earlier connections. */
export function mergeArrowBinding(
  current: readonly BoundElementRef[] | null,
  arrowId: string,
): readonly BoundElementRef[] {
  const kept = current ?? [];
  return kept.some((ref) => ref.id === arrowId)
    ? kept
    : [...kept, { id: arrowId as ElementId, type: "arrow" }];
}
