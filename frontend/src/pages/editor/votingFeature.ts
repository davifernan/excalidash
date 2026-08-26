import { Vote } from "lucide-react";
import { defineEditorFeature } from "./featureRegistry";

/**
 * Starting a vote is an editable, connected board action. It is deliberately
 * absent while another round exists and from element-scoped surfaces: in all
 * three cases the existing compose action would have no effect.
 */
export const votingFeature = defineEditorFeature({
  id: "voting",
  name: "Start a vote",
  icon: Vote,
  shortcut: null,
  isApplicable: (context) =>
    context.boardId !== null &&
    context.target.kind === "board" &&
    context.canEdit &&
    context.connectionStatus === "connected" &&
    context.votingStatus === "idle",
  invoke: (context) => context.actions.startVote(),
});
