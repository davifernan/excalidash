import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2 } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getDocumentAsset,
  getDocumentContent,
  getDocumentOriginalUrl,
  renameDocumentAsset,
  type TextAsset,
} from "../../api";
import type { AssetWidgetKind } from "./pdfWidgetElements";
import { paginateDocumentOffThread } from "./documentPaginationWorker";
import { useSharedDocumentPage, type DocumentPageSharing } from "./useSharedDocumentPage";
import { ElementFloatingToolbar } from "./ElementFloatingToolbar";
import type { FloatingToolbarTarget } from "./floatingToolbarGeometry";
import { EditableAssetName } from "./EditableAssetName";
import "./TextDocumentWidget.css";

const markdownComponents: Components = {
  a: ({ node: _node, href, children, ...props }) => {
    const safeHref = href && /^(?:https?:|mailto:)/i.test(href) ? href : undefined;
    const external = safeHref && /^https?:/i.test(safeHref);
    return (
      <a
        {...props}
        href={safeHref}
        rel={external ? "noopener noreferrer" : undefined}
        target={external ? "_blank" : undefined}
      >
        {children}
      </a>
    );
  },
  img: () => null,
};

type TextDocumentWidgetProps = {
  assetId: string;
  drawingId: string;
  theme: "light" | "dark";
  canEdit?: boolean;
  widgetKind: Extract<AssetWidgetKind, "markdown" | "text">;
  sharing: DocumentPageSharing;
  toolbar: FloatingToolbarTarget | null;
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
}: TextDocumentWidgetProps) => {
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [pages, setPages] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setLoaded(null);
    setPages(null);
    setError(null);
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
    void paginateDocumentOffThread(loaded.content, loaded.asset.kind, controller.signal)
      .then(setPages)
      .catch((paginationError: unknown) => {
        if (paginationError instanceof DOMException && paginationError.name === "AbortError")
          return;
        setError("Unable to prepare this document.");
      });
    return () => controller.abort();
  }, [loaded]);

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
        {pages && loaded?.asset.kind === "TEXT" ? (
          <pre className="text-document-widget__plain">{page}</pre>
        ) : null}
        {pages && loaded?.asset.kind === "MARKDOWN" ? (
          <div className="text-document-widget__markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {page}
            </ReactMarkdown>
          </div>
        ) : null}
      </div>
      {loaded && pages ? (
        <ElementFloatingToolbar target={toolbar} label="Document controls">
          <div className="text-document-widget__controls">
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
            {pageCount > 1 ? (
              <>
                <button
                  type="button"
                  className="text-document-widget__button"
                  aria-label="Previous page"
                  disabled={pending || pageIndex === 0}
                  onClick={() => changePage(-1)}
                >
                  <ChevronLeft size={18} />
                </button>
                <span className="text-document-widget__page-number">
                  Page {pageIndex + 1} of {pageCount}
                </span>
                <button
                  type="button"
                  className="text-document-widget__button"
                  aria-label="Next page"
                  disabled={pending || pageIndex === pageCount - 1}
                  onClick={() => changePage(1)}
                >
                  <ChevronRight size={18} />
                </button>
              </>
            ) : (
              <span>{loaded.asset.kind === "MARKDOWN" ? "Markdown" : "Plain text"}</span>
            )}
            <a
              className="text-document-widget__button"
              href={downloadUrl}
              download={loaded.asset.name}
              aria-label="Download original document"
              title="Download original document"
            >
              <Download size={17} />
            </a>
          </div>
        </ElementFloatingToolbar>
      ) : null}
    </div>
  );
};
