import { commentsFeature } from "./comments/commentsFeature";
import { EditorFeatureRegistry } from "./featureRegistry";
import { votingFeature } from "./votingFeature";
import { workshopTimerFeature } from "./workshopTimerFeature";

/**
 * Composition root for ExcaliDash-owned editor features. Excalidraw's native
 * tools do not belong here; they remain behind the integration adapter and in
 * Excalidraw's own toolbar/command contracts.
 */
export const editorFeatureRegistry = new EditorFeatureRegistry([
  workshopTimerFeature,
  votingFeature,
  commentsFeature,
]);
