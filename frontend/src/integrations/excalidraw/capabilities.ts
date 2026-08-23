/**
 * The capability contract.
 *
 * Scope comes from docs/architecture/EXCALIDRAW_ADAPTER.md and is already
 * agreed. What is decided here is the shape: signatures, the sync/async split,
 * and which failures are hard rather than degradable.
 *
 * Measured surface this has to carry (main 85c3919): 74 API call sites over 12
 * methods in 19 files, ~20 AppState fields, 13 props and 2 children slots.
 *
 * Sync/async rule, stated precisely because the obvious version is wrong:
 * reads are synchronous, and *enqueueing* a write is synchronous, but the
 * write taking visible effect is not. The editor commits through React state,
 * which is why placing a sticky note has to wait a frame before its Enter can
 * land (stickyPlacement.ts) and why arming the arrow tool has to wait a frame
 * before the pointer event can (stickyConnect.ts). Callers that depend on the
 * committed state use the `Settled` variant instead of writing their own
 * requestAnimationFrame against editor internals.
 */

import type { CapabilityResult } from "./errors";
import type {
  ActiveTool,
  AppliedViewport,
  BoardSettings,
  CollaboratorInfo,
  CollaboratorPatch,
  ElementId,
  ElementSummary,
  FileId,
  FollowIntent,
  FollowState,
  HistoryCapture,
  InteractionState,
  PointerUpdate,
  SceneBounds,
  SceneDocument,
  SceneFile,
  SceneOp,
  ScenePoint,
  SelectionState,
  SocketId,
  Unsubscribe,
  ViewportPoint,
  ViewportState,
} from "./types";

export interface SceneCapability {
  /**
   * The complete scene, lossless. What persistence, export and the
   * collaboration merge hand around. Nothing may be read out of it directly.
   */
  readDocument(options?: { includeDeleted?: boolean }): CapabilityResult<SceneDocument>;

  /** The read projection: geometry, frames, links, customData. */
  summaries(options?: { includeDeleted?: boolean }): CapabilityResult<readonly ElementSummary[]>;
  summaryById(id: ElementId): CapabilityResult<ElementSummary | null>;

  /**
   * Apply a list of operations as ONE editor update.
   *
   * Atomicity is the point. Placing a sticky note writes elements, selection
   * and item defaults together today; splitting that into three calls would
   * make three renders out of one and let a remote change land in between.
   */
  apply(ops: readonly SceneOp[], options?: { capture?: HistoryCapture }): CapabilityResult<void>;

  /** As `apply`, resolving once the editor has committed the change. */
  applySettled(
    ops: readonly SceneOp[],
    options?: { capture?: HistoryCapture; timeoutMs?: number },
  ): Promise<CapabilityResult<void>>;

  /** onChange. Fires on every editor change; consumers throttle. */
  subscribe(listener: () => void): Unsubscribe;
}

export interface BoardSettingsCapability {
  read(): CapabilityResult<BoardSettings>;
  subscribe(listener: (settings: BoardSettings) => void): Unsubscribe;
}

export interface SelectionCapability {
  read(): CapabilityResult<SelectionState>;
  subscribe(listener: (selection: SelectionState) => void): Unsubscribe;
  /** Anchor for a comment, from a canvas point. Used from M3. */
  anchorAt(point: ScenePoint): CapabilityResult<ElementId | null>;
}

export interface FileCapability {
  read(): CapabilityResult<Readonly<Record<FileId, SceneFile>>>;
  add(files: readonly SceneFile[]): CapabilityResult<void>;
  /**
   * Files in the editor that the confirmed server baseline does not have. The
   * baseline is owned by the caller and passed in; this layer keeps no sync
   * state of its own.
   */
  deltaAgainst(confirmed: ReadonlySet<FileId>): CapabilityResult<readonly SceneFile[]>;
}

export interface ViewportCapability {
  read(): CapabilityResult<ViewportState>;
  visibleBounds(): CapabilityResult<SceneBounds>;

  /**
   * Show these bounds and report what actually happened. Follow compares the
   * viewport it got against the one it asked for and tells the user when the
   * zoom hit a limit, so an acknowledgement alone is not enough.
   */
  showBounds(
    bounds: SceneBounds,
    options?: { animate?: boolean },
  ): CapabilityResult<AppliedViewport>;

  scrollToElement(id: ElementId): CapabilityResult<AppliedViewport>;
  toViewport(point: ScenePoint): CapabilityResult<ViewportPoint>;
  toScene(point: ViewportPoint): CapabilityResult<ScenePoint>;

  /** onScrollChange -- follow broadcasts its bounds from this. */
  subscribeScroll(listener: (viewport: ViewportState) => void): Unsubscribe;
}

export interface CollaborationCapability {
  readCollaborators(): CapabilityResult<readonly CollaboratorInfo[]>;

  /**
   * Merge into existing collaborators. A patch rather than a replacement
   * because the editor keeps fields on a collaborator that this contract does
   * not name -- colour, pointer button, cursor state -- and remote selection
   * updates only one of them at a time.
   */
  patchCollaborators(patches: readonly CollaboratorPatch[]): CapabilityResult<void>;
  removeCollaborators(socketIds: readonly SocketId[]): CapabilityResult<void>;

  readFollowState(): CapabilityResult<FollowState>;
  follow(socketId: SocketId | null): CapabilityResult<void>;
  setFollowedBy(socketIds: readonly SocketId[]): CapabilityResult<void>;

  /**
   * onUserFollow: the editor's own UI asked to follow somebody. A command and
   * an event are different things -- `follow()` cannot stand in for this.
   */
  onFollowIntent(listener: (intent: FollowIntent) => void): Unsubscribe;

  /** The local pointer stream this client broadcasts. */
  onPointerUpdate(listener: (update: PointerUpdate) => void): Unsubscribe;
}

export interface InteractionCapability {
  /**
   * The riskiest read in the inventory: what the editor is currently editing,
   * creating or resizing has no product contract. Isolated here so a break is
   * one adapter failure rather than four product bugs.
   */
  read(): CapabilityResult<InteractionState>;
  subscribe(listener: (state: InteractionState) => void): Unsubscribe;
  setActiveTool(tool: ActiveTool): CapabilityResult<void>;
  /** As setActiveTool, resolving once the tool is actually armed. */
  setActiveToolSettled(
    tool: ActiveTool,
    options?: { timeoutMs?: number },
  ): Promise<CapabilityResult<void>>;
  onPointerDown(listener: (point: ScenePoint, tool: ActiveTool) => void): Unsubscribe;
}

export type WidgetDescriptor = {
  readonly kind: "pdf" | "markdown" | "text";
  readonly schemaVersion: number;
  readonly assetId: string;
};

export interface WidgetCapability {
  /** Recognise an ExcaliDash widget from its customData (NIL-334). */
  identify(element: ElementSummary): CapabilityResult<WidgetDescriptor | null>;
  describe(descriptor: WidgetDescriptor, at: ScenePoint): CapabilityResult<SceneOp>;
  /**
   * Whether a viewer can operate an embedded widget in the current mode.
   * Open on measurement (NIL-311): Excalidraw activates an embeddable only on
   * double click and guards that path with !viewModeEnabled, while this
   * application sets viewModeEnabled={!canEdit}. If a read-only visitor cannot
   * activate it, this reports "read-only" and the widget shows a static view
   * instead of buttons that do nothing.
   */
  interactionMode(): CapabilityResult<"interactive" | "read-only">;
}

export type ExportOptions = {
  readonly document: SceneDocument;
  readonly padding?: number;
  readonly withBackground?: boolean;
  /** Off by default. Metadata and comments only on an explicit decision. */
  readonly includeMetadata?: boolean;
};

export interface ExportCapability {
  /**
   * A clone of the document with widgets swapped for stable substitutes.
   * NIL-277: today a board with a PDF or markdown widget exports as an empty
   * box with a URL -- in the file export, the dashboard thumbnail and the MCP
   * PNG export alike.
   */
  exportableDocument(document: SceneDocument): CapabilityResult<SceneDocument>;
  toSvg(options: ExportOptions): Promise<CapabilityResult<SVGSVGElement>>;
}

/**
 * A scene shown temporarily, with a guaranteed way back.
 *
 * Version-history preview needs exactly this: show a snapshot, then restore
 * what was there before without having gone through a lossy projection on the
 * way. `restore` returns the document that was live when `begin` was called.
 */
export interface PreviewTransaction {
  restore(): Promise<CapabilityResult<void>>;
  readonly previous: SceneDocument;
}

export interface HistoryCapability {
  beginPreview(document: SceneDocument): Promise<CapabilityResult<PreviewTransaction>>;
}

export type ChromeState = { readonly zenMode: boolean; readonly mobile: boolean };

export interface UiCapability {
  /**
   * The Excalidraw DOM node this application's overlays are portalled into.
   * Six of them resolve it with a `.excalidraw` querySelector of their own
   * today; after the migration only the DOM bridge does.
   */
  overlayRoot(): CapabilityResult<HTMLElement>;
  /**
   * Optional toolbar mount. Not-ok with fallback "main-menu" when there is no
   * toolbar, which is the normal case in zen and view mode.
   */
  toolbarSlot(): CapabilityResult<HTMLElement>;
  readChrome(): CapabilityResult<ChromeState>;
  subscribeChrome(listener: (chrome: ChromeState) => void): Unsubscribe;
  /** updateLibrary: genuinely async, and the caller needs the result back. */
  importLibrary(
    source: Blob | readonly unknown[],
    options?: { merge?: boolean },
  ): Promise<CapabilityResult<readonly unknown[]>>;
  /**
   * Start editing an element's label.
   *
   * This is the synthetic Enter after placing a sticky note. NIL-308: it works,
   * but nothing notices when it stops. This resolves once the editor really is
   * editing rather than one frame later -- the mistake that made the old toast
   * cry wolf and got it removed.
   */
  beginTextEditing(
    id: ElementId,
    options?: { timeoutMs?: number },
  ): Promise<CapabilityResult<void>>;
}

export type SeamReport = {
  readonly checked: number;
  readonly missing: readonly string[];
  readonly changed: readonly string[];
};

/** Never contains board content, element text or user identity. */
export type DiagnosticEvent = {
  readonly seam: string;
  readonly code: string;
  readonly fallback?: string;
  readonly packageVersion: string;
};

export interface CompatibilityCapability {
  packageVersion(): string;
  verifySeams(): CapabilityResult<SeamReport>;
  onDiagnostic(listener: (event: DiagnosticEvent) => void): Unsubscribe;
}

export interface ExcalidrawAdapter {
  readonly scene: SceneCapability;
  readonly boardSettings: BoardSettingsCapability;
  readonly selection: SelectionCapability;
  readonly files: FileCapability;
  readonly viewport: ViewportCapability;
  readonly collaboration: CollaborationCapability;
  readonly interaction: InteractionCapability;
  readonly widgets: WidgetCapability;
  readonly export: ExportCapability;
  readonly history: HistoryCapability;
  readonly ui: UiCapability;
  readonly compatibility: CompatibilityCapability;
}
