import { Clock3 } from "lucide-react";
import { defineEditorFeature } from "./featureRegistry";

/** The timer is board chrome: it has no meaning on an individual element. */
export const workshopTimerFeature = defineEditorFeature({
  id: "workshop-timer",
  name: "Workshop timer",
  icon: Clock3,
  shortcut: null,
  isApplicable: (context) =>
    context.boardId !== null && context.accessLevel !== "none" && context.target.kind === "board",
  invoke: (context) => context.actions.openWorkshopTimer(),
});
