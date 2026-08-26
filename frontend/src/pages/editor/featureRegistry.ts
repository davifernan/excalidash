import type { LucideIcon } from "lucide-react";
import type { ConnectionStatus } from "./useEditorCollaboration";
import type { VotingStatus } from "./votingMode";

export type EditorFeatureId = "workshop-timer" | "voting" | "comments";
export type EditorFeatureAccessLevel = "none" | "view" | "comment" | "edit" | "owner";

export type EditorFeatureTarget =
  | { readonly kind: "board" }
  | {
      readonly kind: "element";
      readonly elementId: string;
      readonly elementType: string;
    };

export type EditorFeatureContext = {
  readonly boardId: string | null;
  readonly accessLevel: EditorFeatureAccessLevel;
  readonly canEdit: boolean;
  readonly canComment: boolean;
  readonly connectionStatus: ConnectionStatus;
  readonly votingStatus: VotingStatus;
  readonly target: EditorFeatureTarget;
  readonly actions: {
    readonly openWorkshopTimer: () => void;
    readonly startVote: () => void;
    readonly openComments: (target: EditorFeatureTarget) => void;
  };
};

/**
 * Keyboard metadata is explicit even when a feature has no binding today.
 * `null` is a decision, not an omitted field a consumer may guess at. This
 * matters here because Excalidraw already owns most single-letter shortcuts;
 * assigning one while merely cataloguing ExcaliDash features would silently
 * collide with its tool contract.
 */
export type EditorFeatureShortcut = {
  readonly label: string;
  readonly key: string;
  readonly modifiers?: readonly ("alt" | "mod" | "shift")[];
};

export type EditorFeatureMetadata = {
  readonly id: EditorFeatureId;
  readonly name: string;
  readonly icon: LucideIcon;
  readonly shortcut: EditorFeatureShortcut | null;
};

export type EditorFeatureDefinition = EditorFeatureMetadata & {
  /**
   * Applicability belongs to the feature, not to whichever surface happens
   * to render it. A toolbar, command palette, or element menu therefore asks
   * the same question and cannot grow its own ambient visibility rule.
   */
  readonly isApplicable: (context: EditorFeatureContext) => boolean;
  readonly invoke: (context: EditorFeatureContext) => void | Promise<void>;
};

export type EditorFeatureInvocationResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: "not-found" | "not-applicable" };

export const defineEditorFeature = <T extends EditorFeatureDefinition>(definition: T): T =>
  Object.freeze(definition);

/**
 * The registry is the sole invocation gate. Consumers only receive metadata;
 * the callable definition stays private so they cannot forget to apply the
 * feature's own context rule before invoking it.
 */
export class EditorFeatureRegistry {
  readonly #definitions: readonly EditorFeatureDefinition[];

  constructor(definitions: readonly EditorFeatureDefinition[]) {
    const ids = new Set<EditorFeatureId>();
    for (const definition of definitions) {
      if (ids.has(definition.id)) {
        throw new Error(`Duplicate editor feature id: ${definition.id}`);
      }
      ids.add(definition.id);
    }
    this.#definitions = Object.freeze([...definitions]);
  }

  all(): readonly EditorFeatureMetadata[] {
    return this.#definitions.map(({ id, name, icon, shortcut }) => ({
      id,
      name,
      icon,
      shortcut,
    }));
  }

  applicable(context: EditorFeatureContext): readonly EditorFeatureMetadata[] {
    return this.#definitions
      .filter((definition) => definition.isApplicable(context))
      .map(({ id, name, icon, shortcut }) => ({ id, name, icon, shortcut }));
  }

  async invoke(
    id: EditorFeatureId,
    context: EditorFeatureContext,
  ): Promise<EditorFeatureInvocationResult> {
    const definition = this.#definitions.find((candidate) => candidate.id === id);
    if (!definition) return { ok: false, reason: "not-found" };
    if (!definition.isApplicable(context)) return { ok: false, reason: "not-applicable" };
    await definition.invoke(context);
    return { ok: true };
  }
}
