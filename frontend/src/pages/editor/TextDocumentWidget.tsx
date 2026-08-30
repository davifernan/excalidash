import { useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Bold,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  Heading2,
  Italic,
  Link,
  List,
  Loader2,
  Pencil,
  Save,
  X,
} from "lucide-react";
import {
  getDocumentAsset,
  getDocumentContent,
  getDocumentOriginalUrl,
  renameDocumentAsset,
  replaceMarkdownContent,
  type TextAsset,
} from "../../api";
import type { AssetWidgetKind } from "./pdfWidgetElements";
import { paginateDocumentOffThread } from "./documentPaginationWorker";
import { useSharedDocumentPage, type DocumentPageSharing } from "./useSharedDocumentPage";
import { ElementFloatingToolbar } from "./ElementFloatingToolbar";
import type { FloatingToolbarTarget } from "./floatingToolbarGeometry";
import { EditableAssetName } from "./EditableAssetName";
import type { DocumentEditLock, DocumentEditResult } from "./documentEditLocks";
import type { DocumentAssetReplacement } from "./documentAssetReplacement";
import type { DocumentEditDraft } from "./documentEditDrafts";
import { applyMarkdownFormat, type MarkdownFormatAction } from "./markdownFormatting";
import { MarkdownDocumentView, type PreparedMarkdown } from "./MarkdownDocumentView";
import { renderMarkdownOffThread } from "./documentMarkdownWorker";
import "./TextDocumentWidget.css";

type TextDocumentWidgetProps = {
  assetId: string;
  drawingId: string;
  theme: "light" | "dark";
  canEdit?: boolean;
  widgetKind: Extract<AssetWidgetKind, "markdown" | "text">;
  sharing: DocumentPageSharing;
  toolbar: FloatingToolbarTarget | null;
  editLock?: DocumentEditLock | null;
  liveDraft?: DocumentEditDraft | null;
  onAcquireEditLock?: () => Promise<DocumentEditResult>;
  onReleaseEditLock?: (token: string) => void;
  onBeginLiveDraft?: (token: string, content: string) => void;
  onUpdateLiveDraft?: (content: string) => void;
  onCancelLiveDraft?: () => void;
  onEndLiveDraft?: () => void;
  onBeforeDocumentAssetReplacement?: () => Promise<void>;
  onDocumentAssetReplacement?: (replacement: DocumentAssetReplacement) => Promise<boolean>;
};

type LoadedDocument = { asset: TextAsset; content: string };

export const TextDocumentWidget = ({
  assetId,
  drawingId,
  theme,
  canEdit = false,
  widgetKind,
  sharing,
  toolbar,
  editLock = null,
  liveDraft = null,
  onAcquireEditLock,
  onReleaseEditLock,
  onBeginLiveDraft,
  onUpdateLiveDraft,
  onCancelLiveDraft,
  onEndLiveDraft,
  onBeforeDocumentAssetReplacement,
  onDocumentAssetReplacement,
}: TextDocumentWidgetProps) => {
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [pages, setPages] = useState<string[] | null>(null);
  const [preparedMarkdown, setPreparedMarkdown] = useState<PreparedMarkdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editToken, setEditToken] = useState<string | null>(null);
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const editTokenRef = useRef<string | null>(null);
  const releaseRef = useRef(onReleaseEditLock);
  const cancelDraftRef = useRef(onCancelLiveDraft);
  const sharedPageRef = useRef(sharing.sharedPage);
  releaseRef.current = onReleaseEditLock;
  cancelDraftRef.current = onCancelLiveDraft;
  editTokenRef.current = editToken;
  sharedPageRef.current = sharing.sharedPage;

  useEffect(
    () => () => {
      if (editTokenRef.current) {
        cancelDraftRef.current?.();
        releaseRef.current?.(editTokenRef.current);
      }
    },
    [assetId],
  );

  useEffect(() => {
    let active = true;
    setLoaded(null);
    setPages(null);
    setPreparedMarkdown(null);
    setError(null);
    setEditing(false);
    setEditToken(null);
    setEditMessage(null);
    Promise.all([getDocumentAsset(drawingId, assetId), getDocumentContent(drawingId, assetId)])
      .then(([asset, content]) => {
        if (!active) return;
        const expected = widgetKind === "markdown" ? "MARKDOWN" : "TEXT";
        if (asset.kind !== expected) {
          setError("This document does not match the widget type.");
          return;
        }
        setLoaded({ asset, content });
      })
      .catch(() => {
        if (active) setError("Unable to load this document.");
      });
    return () => {
      active = false;
    };
  }, [assetId, drawingId, widgetKind]);

  useEffect(() => {
    if (!loaded) return;
    const controller = new AbortController();
    setPages(null);
    setPreparedMarkdown(null);
    void paginateDocumentOffThread(loaded.content, loaded.asset.kind, controller.signal)
      .then(async (preparedPages) => {
        let prepared: PreparedMarkdown | null = null;
        if (loaded.asset.kind === "MARKDOWN") {
          const requestedPage = sharedPageRef.current ?? 1;
          const initialIndex = Math.min(
            Math.max(0, requestedPage - 1),
            Math.max(0, preparedPages.length - 1),
          );
          const source = preparedPages[initialIndex] ?? "";
          prepared = {
            source,
            tree: await renderMarkdownOffThread(source, controller.signal),
          };
        }
        setPreparedMarkdown(prepared);
        setPages(preparedPages);
      })
      .catch((paginationError: unknown) => {
        if (paginationError instanceof DOMException && paginationError.name === "AbortError")
          return;
        setError("Unable to prepare this document.");
      });
    return () => controller.abort();
  }, [loaded]);

  // React deprioritizes work computed from a deferred value, so a large
  // document's Markdown re-parse on every keystroke never competes with the
  // textarea's own commit -- typing latency is unaffected by construction,
  // not by tuning a debounce delay (NIL-583, precedent: NIL-551).
  const deferredDraft = useDeferredValue(draft);
  const deferredLiveDraft = useDeferredValue(liveDraft?.content ?? null);

  useLayoutEffect(() => {
    const selection = pendingSelectionRef.current;
    const editor = editorRef.current;
    if (!selection || !editor) return;
    pendingSelectionRef.current = null;
    editor.focus();
    editor.setSelectionRange(selection.start, selection.end);
  }, [draft]);

  const pageCount = pages?.length ?? 0;
  const {
    page: pageNumber,
    pending,
    goToPage,
  } = useSharedDocumentPage({
    sharing,
    pageCount,
  });
  const pageIndex = Math.min(Math.max(0, pageNumber - 1), Math.max(0, pageCount - 1));

  const downloadUrl = getDocumentOriginalUrl(drawingId, assetId);
  const page = pages?.[pageIndex] ?? "";

  const changePage = (direction: 1 | -1) => {
    goToPage(pageNumber + direction);
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
      bodyRef.current.scrollLeft = 0;
    }
  };

  const releaseEdit = () => {
    if (editToken) {
      onCancelLiveDraft?.();
      onReleaseEditLock?.(editToken);
    }
    setEditToken(null);
    setEditing(false);
    setSaving(false);
    setEditMessage(null);
  };

  const beginEditing = async () => {
    if (!loaded || loaded.asset.kind !== "MARKDOWN" || !onAcquireEditLock) return;
    setEditMessage(null);
    const result = await onAcquireEditLock();
    if (!result.ok) {
      setEditMessage(result.error.message);
      return;
    }
    setEditToken(result.token);
    setDraft(loaded.content);
    setEditing(true);
    onBeginLiveDraft?.(result.token, loaded.content);
  };

  const updateDraft = (content: string) => {
    setDraft(content);
    onUpdateLiveDraft?.(content);
  };

  const formatDraft = (action: MarkdownFormatAction) => {
    const editor = editorRef.current;
    if (!editor) return;
    const formatted = applyMarkdownFormat(
      draft,
      editor.selectionStart,
      editor.selectionEnd,
      action,
    );
    pendingSelectionRef.current = {
      start: formatted.selectionStart,
      end: formatted.selectionEnd,
    };
    updateDraft(formatted.value);
  };

  const saveDraft = async () => {
    if (
      !loaded ||
      loaded.asset.kind !== "MARKDOWN" ||
      !loaded.asset.revision ||
      !editToken ||
      !onDocumentAssetReplacement
    ) {
      setEditMessage("This Markdown revision cannot be saved. Reload the board and try again.");
      return;
    }
    setSaving(true);
    setEditMessage(null);
    let persisted = false;
    try {
      // A queued scene snapshot may still name the old immutable Asset. It
      // must finish before the server atomically replaces that Asset id.
      await onBeforeDocumentAssetReplacement?.();
      const replacement = await replaceMarkdownContent(
        drawingId,
        assetId,
        sharing.elementId,
        draft,
        loaded.asset.revision,
        editToken,
      );
      persisted = true;
      // The HTTP write atomically releases the server lock. End the local
      // publisher before applying the replacement scene so an asset-id remount
      // cannot run the unmount cleanup with a token that is already spent.
      onEndLiveDraft?.();
      editTokenRef.current = null;
      setEditToken(null);
      const applied = await onDocumentAssetReplacement({
        drawingId,
        previousAssetId: assetId,
        assetId: replacement.id,
        drawingVersion: replacement.drawingVersion,
        elements: replacement.elements,
      });
      if (!applied) {
        setEditing(false);
        setEditMessage("Saved. Reload the board to show the new Markdown version.");
        return;
      }
      setLoaded({ asset: replacement, content: draft });
      setEditing(false);
    } catch (saveError: any) {
      if (persisted) {
        setEditing(false);
        setEditMessage("Saved. Reload the board to show the new Markdown version.");
      } else {
        setEditMessage(
          saveError?.response?.data?.message ||
            "The Markdown file could not be saved. Your draft is still open.",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`text-document-widget${theme === "dark" ? " text-document-widget--dark" : ""}`}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="text-document-widget__body" ref={bodyRef}>
        {(!loaded || !pages) && !error ? (
          <Loader2 aria-label="Loading document" className="animate-spin" />
        ) : null}
        {error ? <p className="text-document-widget__status">{error}</p> : null}
        {editing ? (
          <div className="text-document-widget__edit-split">
            <div className="text-document-widget__edit-source">
              <div
                className="text-document-widget__formatting"
                role="toolbar"
                aria-label="Markdown formatting"
              >
                {(
                  [
                    ["bold", "Bold", Bold],
                    ["italic", "Italic", Italic],
                    ["heading", "Heading", Heading2],
                    ["list", "Bulleted list", List],
                    ["link", "Link", Link],
                    ["code", "Inline code", Code2],
                  ] as const
                ).map(([action, label, Icon]) => (
                  <button
                    key={action}
                    type="button"
                    className="text-document-widget__format-button"
                    aria-label={label}
                    title={label}
                    disabled={saving}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => formatDraft(action)}
                  >
                    <Icon size={15} />
                  </button>
                ))}
              </div>
              <textarea
                ref={editorRef}
                className="text-document-widget__editor"
                aria-label="Markdown source"
                value={draft}
                disabled={saving}
                spellCheck
                onChange={(event) => updateDraft(event.target.value)}
              />
            </div>
            <span className="text-document-widget__edit-divider" aria-hidden="true" />
            {/* The preview and view mode share the same off-thread parser and sanitizer. */}
            <div
              className="text-document-widget__markdown text-document-widget__edit-preview"
              aria-label="Markdown preview"
            >
              <MarkdownDocumentView source={deferredDraft} />
            </div>
          </div>
        ) : null}
        {!editing && pages && loaded?.asset.kind === "TEXT" ? (
          <pre className="text-document-widget__plain">{page}</pre>
        ) : null}
        {!editing && pages && loaded?.asset.kind === "MARKDOWN" ? (
          <div className="text-document-widget__markdown">
            <MarkdownDocumentView
              source={deferredLiveDraft ?? page}
              prepared={deferredLiveDraft === null ? preparedMarkdown : null}
            />
          </div>
        ) : null}
      </div>
      {loaded && pages ? (
        <ElementFloatingToolbar target={toolbar} label="Document controls" compactWhenCrowded>
          <div className="element-floating-toolbar__row">
            <EditableAssetName
              name={loaded.asset.name}
              canEdit={canEdit}
              onRename={async (name) => {
                const renamed = await renameDocumentAsset(drawingId, assetId, name);
                setLoaded((current) =>
                  current
                    ? { ...current, asset: { ...current.asset, name: renamed.name } }
                    : current,
                );
              }}
            />
            <span className="element-floating-toolbar__divider" aria-hidden="true" />
            <div className="element-floating-toolbar__actions">
              {loaded.asset.kind === "MARKDOWN" && canEdit ? (
                editing ? (
                  <>
                    <button
                      type="button"
                      className="element-floating-toolbar__button"
                      aria-label="Save Markdown"
                      disabled={saving}
                      onClick={() => void saveDraft()}
                    >
                      {saving ? <Loader2 size={17} className="animate-spin" /> : <Save size={17} />}
                    </button>
                    <button
                      type="button"
                      className="element-floating-toolbar__button"
                      aria-label="Cancel Markdown editing"
                      disabled={saving}
                      onClick={releaseEdit}
                    >
                      <X size={18} />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="element-floating-toolbar__button"
                    aria-label="Edit Markdown"
                    title={
                      editLock ? `${editLock.ownerName} is editing this file` : "Edit Markdown"
                    }
                    disabled={Boolean(editLock) || !onAcquireEditLock}
                    onClick={() => void beginEditing()}
                  >
                    <Pencil size={17} />
                  </button>
                )
              ) : null}
              {editLock && !editing ? (
                <span className="text-document-widget__lock" role="status">
                  Editing: {editLock.ownerName}
                </span>
              ) : null}
              {editMessage ? (
                <span className="text-document-widget__edit-message" role="status">
                  {editMessage}
                </span>
              ) : null}
              {!editing && pageCount > 1 ? (
                <>
                  <button
                    type="button"
                    className="element-floating-toolbar__button"
                    aria-label="Previous page"
                    disabled={pending || pageIndex === 0}
                    onClick={() => changePage(-1)}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <span className="element-floating-toolbar__page-number">
                    Page {pageIndex + 1} of {pageCount}
                  </span>
                  <button
                    type="button"
                    className="element-floating-toolbar__button"
                    aria-label="Next page"
                    disabled={pending || pageIndex === pageCount - 1}
                    onClick={() => changePage(1)}
                  >
                    <ChevronRight size={18} />
                  </button>
                </>
              ) : !editing ? (
                <span>{loaded.asset.kind === "MARKDOWN" ? "Markdown" : "Plain text"}</span>
              ) : null}
              <a
                className="element-floating-toolbar__button"
                href={downloadUrl}
                download={loaded.asset.name}
                aria-label="Download original document"
                title="Download original document"
              >
                <Download size={17} />
              </a>
            </div>
          </div>
        </ElementFloatingToolbar>
      ) : null}
    </div>
  );
};
