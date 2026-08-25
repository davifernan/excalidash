/**
 * Local types for the Excalidraw boundary.
 *
 * Today the boundary is untyped: `git grep 'import type.*@excalidraw'` returns
 * nothing, `ExcalidrawImperativeAPI` appears nowhere, and the props in
 * EditorView are `any`. These types are the first typing this seam has had.
 *
 * The central decision is the split between two roles that a single element
 * type cannot fill at once:
 *
 *   SceneDocument   opaque and lossless. What persistence, export and
 *                   collaboration move around. Product code never reads
 *                   fields off it.
 *   ElementSummary  a small read projection. What hit-testing, geometry and
 *                   widget identification ask questions of.
 *
 * Collapsing the two is the mistake this file exists to avoid: the save path
 * writes the element array straight to the server (useEditorPersistence.ts),
 * so a projection used as the document type silently drops text, styles,
 * points, bindings, fileId and the version fields on the next save.
 */

/** Opaque handles. Product code never parses an id. */
export type ElementId = string & { readonly __brand: "ElementId" };
export type FileId = string & { readonly __brand: "FileId" };
export type SocketId = string & { readonly __brand: "SocketId" };

declare const documentBrand: unique symbol;

/**
 * A complete scene. Opaque on purpose: product code may hold one, pass it to
 * persistence or export, and compare identity -- but it may not read elements
 * out of it. Everything readable has a capability.
 *
 * The brand buys opacity, not completeness: nothing in the type system stops an
 * adapter from building one out of a projection. Completeness is a property of
 * the implementation, asserted by the contract tests rather than claimed here.
 */
export type SceneDocument = {
  readonly [documentBrand]: true;
};

/**
 * One end of a native Excalidraw binding, as recorded on the *shape* side
 * (`ExcalidrawElement.boundElements`). The arrow side of the same binding is
 * `startBinding`/`endBinding` -- see `ArrowBinding` below, added for NIL-593.
 * See `ElementPatch`'s own comment for why this ref exists at all.
 */
export type BoundElementRef = { readonly id: ElementId; readonly type: "arrow" | "text" };

/**
 * One end of a native Excalidraw *arrow*'s own binding (the arrow side of
 * the same relationship `BoundElementRef` records on the shape side). `null`
 * when that end floats free, unbound to any element.
 *
 * Added for NIL-593: the ambient tree-drag behavior reads `startBinding`/
 * `endBinding` off every arrow to decide direction (which end is the
 * "parent", which is the "child") -- a question `boundElements` alone
 * cannot answer, since a shape's own list does not say which of its bound
 * arrows point AT it versus AWAY from it. Only `elementId` is exposed:
 * nothing today reads an arrow's `focus`/`gap` geometry off this
 * projection, and growing this again later costs one field, not a
 * migration.
 */
export type ArrowBinding = { readonly elementId: ElementId };

/**
 * What product code is actually allowed to know about an element.
 *
 * Every field here is read by a real consumer today: geometry and `angle` by
 * the sticky hit-testing and handles, `frameId` by the placement code,
 * `containerId` by the hint, `link` by the widget identification, `customData`
 * by both sticky and widgets, `boundElements` by the mind map (NIL-575) to
 * keep a node's native bindings in sync when its edges change.
 */
export type ElementSummary = {
  readonly id: ElementId;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
  readonly isDeleted: boolean;
  readonly frameId: ElementId | null;
  readonly containerId: ElementId | null;
  readonly link: string | null;
  readonly customData: Readonly<Record<string, unknown>> | null;
  /**
   * Excalidraw's own frame/magicframe label. Null for every other element
   * type. Added for the Frame Navigator (NIL-325/NIL-284): a presenter needs
   * a human name to list, not just an id, for both a hand-drawn frame and one
   * a workshop template created.
   */
  readonly name: string | null;
  /**
   * Which bound arrows/labels this shape natively knows about, or `null` when
   * the element carries none. Read-only mirror of the raw field; write it
   * back through `ElementPatch.boundElements`, never by reaching around this
   * layer at the raw element.
   */
  readonly boundElements: readonly BoundElementRef[] | null;
  /**
   * An arrow's own two ends (NIL-593). `null` on every non-arrow element,
   * and `null` per end when that end is unbound. See `ArrowBinding`'s own
   * comment for why only `elementId` is exposed.
   */
  readonly startBinding: ArrowBinding | null;
  readonly endBinding: ArrowBinding | null;
};

/**
 * An element this application is creating. Deliberately not an ElementSummary:
 * a summary describes something that exists, this describes something being
 * made, and the adapter fills in every field Excalidraw needs beyond these.
 *
 * The id is supplied by the caller rather than handed back afterwards. Placing
 * a sticky note selects the note it just inserted in the SAME atomic write, and
 * an id that only exists after the write has returned cannot be referenced from
 * inside it. `frameId` is here for the same reason: frame membership is decided
 * before the insert, not patched in afterwards.
 */
export type NewElement = {
  readonly id: ElementId;
  readonly type: "rectangle" | "embeddable";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly frameId?: ElementId | null;
  readonly link?: string;
  readonly backgroundColor?: string;
  readonly strokeColor?: string;
  readonly customData?: Readonly<Record<string, unknown>>;
};

/**
 * A scene as it is stored and sent over the wire.
 *
 * Opaque like SceneDocument, and separate from it on purpose: the save path
 * converts, reconciles against what the server has, and only then serialises.
 * Those are three different states and collapsing them is how a save silently
 * drops what it did not understand.
 */
export type PersistedScene = {
  readonly [documentBrand]: true;
  readonly kind: "persisted";
};

/**
 * The label bound to a container, as the sticky upkeep needs to see it.
 *
 * `originalText` is separate from `text` because Excalidraw stores the text as
 * typed and the text as wrapped, and the upkeep has to reason about the first
 * while the editor is rewriting the second.
 */
export type BoundLabel = {
  readonly id: ElementId;
  readonly containerId: ElementId;
  readonly text: string;
  readonly originalText: string;
  readonly fontSize: number;
};

/** Field-level change to an existing element. Unlisted fields are untouched. */
export type ElementPatch = {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly frameId?: ElementId | null;
  readonly backgroundColor?: string;
  readonly strokeColor?: string;
  readonly fontSize?: number;
  readonly customData?: Readonly<Record<string, unknown>>;
  /**
   * The whole list, replacing whatever the shape had (NIL-575). Named and
   * scoped to exactly this field -- not "the raw element is now open" -- so
   * the contract in `SceneDocument`'s own comment ("opaque and lossless...
   * product code never reads fields off it") keeps holding for everything
   * else. A caller that wants to add or remove one binding reads the
   * shape's current `ElementSummary.boundElements` first and patches the
   * whole array back; there is no merge-one-entry helper because the only
   * consumers today (`mindMap/importElements.ts`, `ambientTree/
   * useAmbientTreeDrag.ts`) always already have the full current list in
   * hand when they need this.
   */
  readonly boundElements?: readonly BoundElementRef[];
};

export type SceneFile = {
  readonly id: FileId;
  readonly mimeType: string;
  readonly dataURL: string;
  readonly created: number;
};

/**
 * Persistent, user-visible board configuration -- deliberately apart from
 * ViewportState: these survive a reload, those do not.
 */
export type BoardSettings = {
  readonly gridModeEnabled: boolean;
  readonly gridSize: number | null;
  readonly gridStep: number | null;
  readonly objectsSnapModeEnabled: boolean;
  readonly viewBackgroundColor: string;
  readonly theme: "light" | "dark";
};

/** Ephemeral camera state. Never persisted as a setting. */
export type ViewportState = {
  readonly zoom: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
  readonly width: number;
  readonly height: number;
};

/**
 * The result of applying a viewport change, not just an acknowledgement.
 * Follow needs the viewport it actually got and whether the zoom hit a limit:
 * without them the caller has to recompute the geometry or read back a state
 * that may already have moved on (followMode.ts).
 */
export type AppliedViewport = {
  readonly viewport: ViewportState;
  readonly bounds: SceneBounds;
  readonly zoomClamped: boolean;
};

export type SceneBounds = readonly [minX: number, minY: number, maxX: number, maxY: number];

export type ScenePoint = { readonly x: number; readonly y: number };
export type ViewportPoint = { readonly x: number; readonly y: number };

/**
 * The tool, as a shape rather than a string. The sticky tool is
 * `{ type: "custom", customType: "sticky" }` -- a bare string cannot say that.
 */
export type ActiveTool =
  | { readonly type: "selection" }
  | { readonly type: "custom"; readonly customType: string }
  | { readonly type: "builtin"; readonly name: string };

/**
 * What the editor is doing right now.
 *
 * Ids rather than booleans: the collaboration merge has to leave an element
 * alone while its own user is still dragging or resizing it, and for that it
 * needs to know *which* element, not merely that something is in flight.
 */
export type InteractionState = {
  readonly editingTextElementId: ElementId | null;
  readonly editingTextContainerId: ElementId | null;
  readonly creatingElementId: ElementId | null;
  readonly resizingElementId: ElementId | null;
  readonly activeTool: ActiveTool;
};

export type SelectionState = {
  readonly selectedIds: readonly ElementId[];
  /** Set when the peer reported a selection too large to enumerate. */
  readonly allSelected: boolean;
};

/**
 * A collaborator as this application understands one.
 *
 * Reads are complete; writes are patches (see CollaborationCapability). The
 * editor keeps fields on a collaborator that this contract does not name --
 * colour, pointer button, cursor state -- and a write that replaced the whole
 * object would drop them.
 */
export type CollaboratorInfo = {
  readonly socketId: SocketId;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  readonly pointer: ScenePoint | null;
  readonly selectedIds: readonly ElementId[];
  readonly selectionAllSelected: boolean;
  /**
   * The three the contract used to leave to the editor.
   *
   * The comment above explains why a write must not *clobber* them -- and that
   * was read as "never name them", which left the presence path unable to
   * migrate: the colour and the pointer button arrive from the server, and a
   * consumer that receives them has to be able to set them. Naming them does not
   * take them away from the editor; a patch still only writes what it mentions.
   */
  readonly color: string | null;
  readonly pointerButton: "up" | "down" | null;
  readonly isSelf: boolean;
};

export type CollaboratorPatch = {
  readonly socketId: SocketId;
} & Partial<Omit<CollaboratorInfo, "socketId">>;

export type FollowState = {
  readonly followingSocketId: SocketId | null;
  readonly followedBySocketIds: readonly SocketId[];
};

/** Why the editor's own UI asked to start or stop following someone. */
export type FollowIntent = {
  readonly targetSocketId: SocketId | null;
  readonly action: string;
};

export type PointerUpdate = {
  readonly point: ScenePoint;
  readonly tool: string;
  readonly button: string;
};

/** How a write is recorded in the editor's undo history. */
export type HistoryCapture = "immediate" | "never" | "eventually";

/**
 * One step of an atomic scene write.
 *
 * A list of these is applied in a single editor update, which is what several
 * consumers already require and the previous draft could not express: placing
 * a sticky note writes elements, selection and the item defaults the label
 * will inherit *together*, and it inserts the note immediately before its
 * frame rather than appending it, because a frame's children sit before it in
 * the element order.
 */
export type SceneOp =
  | {
      readonly kind: "insert";
      readonly elements: readonly NewElement[];
      /** Insert before this element. Omitted means append. */
      readonly before?: ElementId;
    }
  | { readonly kind: "patch"; readonly id: ElementId; readonly changes: ElementPatch }
  | { readonly kind: "remove"; readonly ids: readonly ElementId[] }
  /**
   * Replace the element list wholesale.
   *
   * Distinct from replaceDocument: the caller holds elements it produced
   * itself -- a reconcile against the server, say -- rather than a document
   * this adapter handed out.
   */
  | { readonly kind: "replaceElements"; readonly elements: readonly unknown[] }
  /** Replace the whole scene with a document obtained from this adapter. */
  | { readonly kind: "replaceDocument"; readonly document: SceneDocument }
  | { readonly kind: "select"; readonly ids: readonly ElementId[] }
  /** Defaults the editor applies to the next thing it creates itself. */
  | {
      readonly kind: "itemDefaults";
      readonly fontSize?: number;
      readonly strokeColor?: string;
      readonly backgroundColor?: string;
    }
  | { readonly kind: "settings"; readonly settings: Partial<BoardSettings> }
  | {
      readonly kind: "viewport";
      readonly zoom?: number;
      readonly scrollX?: number;
      readonly scrollY?: number;
    }
  | { readonly kind: "collaborators"; readonly patches: readonly CollaboratorPatch[] };

export type Unsubscribe = () => void;
