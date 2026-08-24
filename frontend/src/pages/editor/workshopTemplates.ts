/**
 * A small, curated workshop-template catalog (NIL-360).
 *
 * A template inserts normal, editable frames and a short instruction note --
 * nothing that only a template understands, and nothing that needs its own
 * renderer. Frame Navigator, the shared timer and voting all already operate
 * on whatever is on the board; a template's only job is to put a sensible
 * starting shape there. Building the elements goes through `buildElements`
 * (`integrations/excalidraw/elements.ts`) the same way `pdfWidgetElements.ts`
 * already does from product code -- Excalidraw fills in every field beyond
 * the few named here, so the result carries angle, seed, version and the rest
 * of the bookkeeping the collaboration merge relies on, the same fix
 * `documentDrop.ts`'s `asWidgetElement` comment describes for a dropped file.
 *
 * Re-running a template is safe by construction: it only ever inserts a fresh
 * set of frames with newly generated ids, so it never mutates or collides
 * with anything already on the board. That is this package's whole reading
 * of "Templateimport ist idempotent" -- repeating the action is harmless, not
 * that a second run is deduplicated against the first.
 */
import { buildElements } from "../../integrations/excalidraw/elements";
import type { SceneCapability } from "../../integrations/excalidraw/capabilities";
import type { NewElement } from "../../integrations/excalidraw/types";

const FRAME_WIDTH = 900;
const FRAME_HEIGHT = 640;
const FRAME_GAP = 120;
const FRAME_Y = 120;

type FrameStep = { readonly name: string; readonly instructions: string };

export type WorkshopTemplate = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly steps: readonly FrameStep[];
};

export const WORKSHOP_TEMPLATES: readonly WorkshopTemplate[] = [
  {
    id: "brainstorming",
    label: "Brainstorming",
    description: "Diverge, then converge: ideas, grouping, and a vote to prioritize.",
    steps: [
      { name: "1. Ideas", instructions: "Add one sticky note per idea. No judging yet." },
      {
        name: "2. Group & Theme",
        instructions: "Drag related ideas together and name each group.",
      },
      { name: "3. Vote & Prioritize", instructions: "Open a vote on the grouped themes." },
    ],
  },
  {
    id: "retrospective",
    label: "Retrospective",
    description: "A standard three-column retro: went well, didn't, and what to do about it.",
    steps: [
      { name: "What went well", instructions: "One sticky note per thing worth keeping." },
      { name: "What didn't go well", instructions: "One sticky note per friction point." },
      { name: "Action items", instructions: "Turn the discussion into concrete next steps." },
    ],
  },
];

let templateElementCounter = 0;
/** Unique within one insert batch; Excalidraw assigns nothing here itself. */
const nextTemplateId = (prefix: string): string => {
  templateElementCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${templateElementCounter}`;
};

const buildTemplateSkeleton = (template: WorkshopTemplate, originX: number, originY: number) => {
  const skeletons: unknown[] = [];
  template.steps.forEach((step, index) => {
    const x = originX + index * (FRAME_WIDTH + FRAME_GAP);
    const y = originY + FRAME_Y;
    const textId = nextTemplateId("template-text");
    skeletons.push({
      type: "text",
      id: textId,
      x: x + 24,
      y: y + 24,
      text: step.instructions,
      fontSize: 20,
      width: FRAME_WIDTH - 48,
    });
    skeletons.push({
      type: "frame",
      id: nextTemplateId("template-frame"),
      x,
      y,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      name: step.name,
      children: [textId],
    });
  });
  return skeletons;
};

/** Inserts the template's frames as one atomic scene write and selects nothing (the presenter picks a frame from the navigator next). */
export const insertWorkshopTemplate = (
  scene: Pick<SceneCapability, "apply">,
  template: WorkshopTemplate,
  origin: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
) => {
  const built = buildElements(buildTemplateSkeleton(template, origin.x, origin.y));
  const elements = built as unknown as NewElement[];
  return scene.apply([{ kind: "insert", elements }], { capture: "immediate" });
};
