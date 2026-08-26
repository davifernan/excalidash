import { MessageSquare } from "lucide-react";
import { defineEditorFeature } from "../featureRegistry";

/**
 * Reading the board's threads is meaningful for every board member. An
 * element-scoped entry promises to act on that element, so it additionally
 * requires comment permission; a view-only user must not be offered an
 * element action that cannot create or attach anything there.
 */
export const commentsFeature = defineEditorFeature({
  id: "comments",
  name: "Comments",
  icon: MessageSquare,
  shortcut: null,
  isApplicable: (context) =>
    context.boardId !== null &&
    context.accessLevel !== "none" &&
    (context.target.kind === "board" || context.canComment),
  invoke: (context) => context.actions.openComments(context.target),
});
