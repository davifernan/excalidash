import { describe, expect, it, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (elements: Array<Record<string, unknown>>) =>
    elements.map((element, index) => ({ id: `element-${index}`, ...element })),
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", NEVER: "NEVER", EVENTUALLY: "EVENTUALLY" },
  newElementWith: (element: Record<string, unknown>, changes: Record<string, unknown>) => ({
    ...element,
    ...changes,
  }),
  restoreElements: (elements: unknown[]) => elements,
}));

import { insertWorkshopTemplate, WORKSHOP_TEMPLATES } from "./workshopTemplates";

describe("WORKSHOP_TEMPLATES", () => {
  it("ships at least the brainstorming and retrospective templates", () => {
    expect(WORKSHOP_TEMPLATES.map((t) => t.id)).toEqual(
      expect.arrayContaining(["brainstorming", "retrospective"]),
    );
  });

  it("every template has at least two frames worth navigating between", () => {
    for (const template of WORKSHOP_TEMPLATES) {
      expect(template.steps.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("insertWorkshopTemplate", () => {
  it("inserts one frame element per step, plus its instruction text", () => {
    const applied: unknown[] = [];
    const scene = {
      apply: vi.fn((ops: unknown[]) => {
        applied.push(...ops);
        return { ok: true, value: undefined };
      }),
    };
    const template = WORKSHOP_TEMPLATES[0];

    const result = insertWorkshopTemplate(scene as never, template);

    expect(result.ok).toBe(true);
    expect(scene.apply).toHaveBeenCalledTimes(1);
    const [ops] = scene.apply.mock.calls[0] as [
      { kind: string; elements: Record<string, unknown>[] }[],
    ];
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("insert");
    const frames = ops[0].elements.filter((el) => el.type === "frame");
    const texts = ops[0].elements.filter((el) => el.type === "text");
    expect(frames).toHaveLength(template.steps.length);
    expect(texts).toHaveLength(template.steps.length);
    expect(frames.map((f) => f.name)).toEqual(template.steps.map((s) => s.name));
  });

  it("lays frames out left to right without overlapping", () => {
    const scene = { apply: vi.fn(() => ({ ok: true, value: undefined })) };
    insertWorkshopTemplate(scene as never, WORKSHOP_TEMPLATES[0]);
    const [ops] = scene.apply.mock.calls[0] as [{ elements: Record<string, unknown>[] }[]];
    const frames = ops[0].elements.filter((el) => el.type === "frame") as {
      x: number;
      width: number;
    }[];
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i].x).toBeGreaterThanOrEqual(frames[i - 1].x + frames[i - 1].width);
    }
  });

  it("each text element's id matches a children entry on its own frame", () => {
    const scene = { apply: vi.fn(() => ({ ok: true, value: undefined })) };
    insertWorkshopTemplate(scene as never, WORKSHOP_TEMPLATES[0]);
    const [ops] = scene.apply.mock.calls[0] as [{ elements: Record<string, unknown>[] }[]];
    const byId = new Map(ops[0].elements.map((el) => [el.id, el]));
    for (const el of ops[0].elements) {
      if (el.type !== "frame") continue;
      for (const childId of el.children as string[]) {
        expect(byId.get(childId)?.type).toBe("text");
      }
    }
  });

  it("produces fresh ids on every call -- re-running a template never collides with itself", () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    const sceneA = {
      apply: vi.fn((ops: unknown[]) => (first.push(...ops), { ok: true, value: undefined })),
    };
    const sceneB = {
      apply: vi.fn((ops: unknown[]) => (second.push(...ops), { ok: true, value: undefined })),
    };
    insertWorkshopTemplate(sceneA as never, WORKSHOP_TEMPLATES[0]);
    insertWorkshopTemplate(sceneB as never, WORKSHOP_TEMPLATES[0]);
    const idsA = (first[0] as { elements: { id: string }[] }).elements.map((e) => e.id);
    const idsB = (second[0] as { elements: { id: string }[] }).elements.map((e) => e.id);
    expect(idsA.some((id) => idsB.includes(id))).toBe(false);
  });
});
