import { Clock3 } from "lucide-react";
import { canViewDrawing } from "@excalidash/domain/authz";
import { defineEditorFeature } from "./featureRegistry";

/** The timer is board chrome: it has no meaning on an individual element. */
export const workshopTimerFeature = defineEditorFeature({
  id: "workshop-timer",
  name: "Workshop timer",
  icon: Clock3,
  shortcut: null,
  isApplicable: (context) =>
    context.boardId !== null &&
    canViewDrawing(context.accessLevel) &&
    context.target.kind === "board",
  invoke: (context) => context.actions.openWorkshopTimer(),
});
