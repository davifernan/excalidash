import { describe, expect, it, vi } from "vitest";
import { editorFeatureRegistry } from "./editorFeatures";
import {
  EditorFeatureRegistry,
  defineEditorFeature,
  type EditorFeatureContext,
  type EditorFeatureTarget,
} from "./featureRegistry";

const boardTarget: EditorFeatureTarget = { kind: "board" };

const context = (overrides: Partial<EditorFeatureContext> = {}): EditorFeatureContext => ({
  boardId: "drawing-1",
  accessLevel: "edit",
  canEdit: true,
  canComment: true,
  connectionStatus: "connected",
  votingStatus: "idle",
  target: boardTarget,
  actions: {
    openWorkshopTimer: vi.fn(),
    startVote: vi.fn(),
    openComments: vi.fn(),
  },
  ...overrides,
});

describe("editorFeatureRegistry", () => {
  it("registers exactly the three existing ExcaliDash features for slice one", () => {
    expect(editorFeatureRegistry.all().map(({ id }) => id)).toEqual([
      "workshop-timer",
      "voting",
      "comments",
    ]);
  });

  it("keeps explicit icon, shortcut, and invocation metadata on every entry", async () => {
    const current = context();

    for (const feature of editorFeatureRegistry.all()) {
      expect(feature.name).not.toBe("");
      expect(feature.icon).toBeTypeOf("object");
      expect(feature).toHaveProperty("shortcut");
      expect(await editorFeatureRegistry.invoke(feature.id, current)).toEqual({ ok: true });
    }

    expect(current.actions.openWorkshopTimer).toHaveBeenCalledOnce();
    expect(current.actions.startVote).toHaveBeenCalledOnce();
    expect(current.actions.openComments).toHaveBeenCalledWith(boardTarget);
  });

  it("applies each feature's own context rule before exposing or invoking it", async () => {
    const elementTarget: EditorFeatureTarget = {
      kind: "element",
      elementId: "shape-1",
      elementType: "rectangle",
    };
    const elementContext = context({ target: elementTarget });

    expect(editorFeatureRegistry.applicable(elementContext).map(({ id }) => id)).toEqual([
      "comments",
    ]);
    expect(await editorFeatureRegistry.invoke("comments", elementContext)).toEqual({ ok: true });
    expect(elementContext.actions.openComments).toHaveBeenCalledOnce();
    expect(elementContext.actions.openComments).toHaveBeenCalledWith(elementTarget);
    expect(await editorFeatureRegistry.invoke("voting", elementContext)).toEqual({
      ok: false,
      reason: "not-applicable",
    });
    expect(elementContext.actions.startVote).not.toHaveBeenCalled();

    const readOnlyElement = context({
      accessLevel: "view",
      canEdit: false,
      canComment: false,
      target: elementTarget,
    });
    expect(editorFeatureRegistry.applicable(readOnlyElement)).toEqual([]);

    const activeVote = context({ votingStatus: "open" });
    expect(editorFeatureRegistry.applicable(activeVote).map(({ id }) => id)).toEqual([
      "workshop-timer",
      "comments",
    ]);

    const offline = context({ connectionStatus: "offline" });
    expect(editorFeatureRegistry.applicable(offline).map(({ id }) => id)).toEqual([
      "workshop-timer",
      "comments",
    ]);

    expect(editorFeatureRegistry.applicable(context({ boardId: null }))).toEqual([]);
  });

  it("rejects duplicate registrations instead of making consumer order decide", () => {
    const duplicate = defineEditorFeature({
      id: "comments",
      name: "Duplicate comments",
      icon: editorFeatureRegistry.all()[2].icon,
      shortcut: null,
      isApplicable: () => true,
      invoke: vi.fn(),
    });

    expect(() => new EditorFeatureRegistry([duplicate, duplicate])).toThrow(
      "Duplicate editor feature id: comments",
    );
  });
});
