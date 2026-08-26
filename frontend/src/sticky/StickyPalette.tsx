/** The colour toolbar for exactly one selected sticky note. */
import React, { useEffect, useState } from "react";
import { notify } from "../notifications";
import type {
  SceneCapability,
  SelectionCapability,
  ViewportCapability,
  InteractionCapability,
} from "../integrations/excalidraw/capabilities";
import type { ElementSummary } from "../integrations/excalidraw/types";
import { ElementFloatingToolbar } from "../pages/editor/ElementFloatingToolbar";
import {
  elementViewportBounds,
  type FloatingToolbarTarget,
} from "../pages/editor/floatingToolbarGeometry";
import {
  STICKY_COLORS,
  isStickyNote,
  recolourSticky,
  stickyColorById,
  stickyDataOf,
  type StickyColor,
} from "./stickyNote";
import "./StickyPalette.css";

type Props = {
  containerRef: React.RefObject<HTMLElement>;
  scene: Pick<SceneCapability, "apply" | "subscribe" | "summaries">;
  selection: Pick<SelectionCapability, "read">;
  viewport: Pick<ViewportCapability, "read" | "subscribeScroll">;
  interaction: Pick<InteractionCapability, "read" | "subscribe">;
  ready: boolean;
  onPick: (color: StickyColor) => void;
};

type PaletteState = {
  note: ElementSummary;
  color: StickyColor;
  target: FloatingToolbarTarget;
};

const stateSignature = (state: PaletteState | null) =>
  state
    ? [
        state.note.id,
        state.color.id,
        state.target.anchor.left,
        state.target.anchor.top,
        state.target.anchor.right,
        state.target.anchor.bottom,
      ]
        .map((value) => (typeof value === "number" ? Math.round(value) : value))
        .join(":")
    : "";

const Swatch = ({ color }: { color: StickyColor }) => (
  <span
    aria-hidden
    style={{
      width: 16,
      height: 16,
      backgroundColor: color.fill,
      border: `1px solid ${color.edge}`,
      borderRadius: 2,
      display: "block",
    }}
  />
);

export const StickyPalette: React.FC<Props> = ({
  containerRef,
  scene,
  selection,
  viewport,
  interaction,
  ready,
  onPick,
}) => {
  const [state, setState] = useState<PaletteState | null>(null);

  useEffect(() => {
    const refresh = () => {
      if (!ready) {
        setState(null);
        return;
      }
      const host = containerRef.current;
      const elements = scene.summaries();
      const selected = selection.read();
      const view = viewport.read();
      const active = interaction.read();
      let next: PaletteState | null = null;

      // The moment somebody thinks about a note's colour is the moment they are
      // typing into it -- so the palette has to survive `editingTextContainerId`
      // pointing at the note, not just a plain selection. `N`, click, type is the
      // path this exists for.
      const editingNoteId = active.ok ? active.value.editingTextContainerId : null;
      const selectedNoteId =
        !editingNoteId &&
        selected.ok &&
        !selected.value.allSelected &&
        selected.value.selectedIds.length === 1 &&
        active.ok &&
        active.value.activeTool.type === "selection"
          ? selected.value.selectedIds[0]
          : null;
      const targetNoteId = editingNoteId ?? selectedNoteId;

      if (host && elements.ok && view.ok && targetNoteId) {
        const note = elements.value.find(
          (element) => element.id === targetNoteId && !element.isDeleted && isStickyNote(element),
        );
        const data = note ? stickyDataOf(note) : null;
        if (note && data) {
          next = {
            note,
            color: stickyColorById(data.color),
            target: { host, anchor: elementViewportBounds(note, view.value) },
          };
        }
      }

      setState((current) => (stateSignature(current) === stateSignature(next) ? current : next));
    };

    refresh();
    const unsubscribeScene = scene.subscribe(refresh);
    const unsubscribeViewport = viewport.subscribeScroll(refresh);
    const unsubscribeInteraction = interaction.subscribe(refresh);
    return () => {
      unsubscribeScene();
      unsubscribeViewport();
      unsubscribeInteraction();
    };
  }, [containerRef, interaction, ready, scene, selection, viewport]);

  const pick = (color: StickyColor) => {
    if (!state) return;
    const recoloured = recolourSticky(state.note, color);
    const result = scene.apply(
      [
        {
          kind: "patch",
          id: state.note.id,
          changes: {
            backgroundColor: recoloured.backgroundColor,
            strokeColor: recoloured.strokeColor,
            customData: recoloured.customData,
          },
        },
      ],
      { capture: "immediate" },
    );
    if (!result.ok) {
      notify("error", "Couldn't change the note colour. Please try again.");
      return;
    }
    onPick(color);
    setState({ ...state, note: recoloured, color });
  };

  return (
    <ElementFloatingToolbar target={state?.target ?? null} label="Note colour">
      <div className="sticky-palette">
        {STICKY_COLORS.map((option) => (
          <button
            key={option.id}
            type="button"
            // A plain click first lets the browser move focus to this button,
            // which ends label editing before the click even fires -- Excalidraw
            // closes the text editor on blur. Preventing pointerdown's default
            // suppresses that focus shift (and the mousedown it implies) while
            // still letting the click event through, so typing can continue
            // right after the colour is picked. See NIL-584.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => pick(option)}
            aria-pressed={option.id === state?.color.id}
            title={option.label}
            className={`sticky-palette__button${
              option.id === state?.color.id ? " sticky-palette__button--selected" : ""
            }`}
          >
            <Swatch color={option} />
            <span className="sr-only">{option.label}</span>
          </button>
        ))}
      </div>
    </ElementFloatingToolbar>
  );
};
