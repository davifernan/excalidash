import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2 } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getDocumentAsset,
  getDocumentContent,
  getDocumentOriginalUrl,
  type TextAsset,
} from "../../api";
import type { AssetWidgetKind } from "./pdfWidgetElements";
import { paginateDocumentSource } from "./documentPagination";
import { useSharedDocumentPage, type DocumentPageSharing } from "./useSharedDocumentPage";
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
  widgetKind: Extract<AssetWidgetKind, "markdown" | "text">;
  sharing: DocumentPageSharing;
};

type LoadedDocument = { asset: TextAsset; content: string };

export const TextDocumentWidget = ({
  assetId,
  drawingId,
  theme,
  widgetKind,
  sharing,
}: TextDocumentWidgetProps) => {
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setLoaded(null);
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

  const pages = useMemo(
    () => (loaded ? paginateDocumentSource(loaded.content, loaded.asset.kind) : []),
    [loaded],
  );

  const pageCount = pages.length;
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
  const page = pages[pageIndex] ?? "";

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
      <div className="text-document-widget__title" title={loaded?.asset.name}>
        {loaded?.asset.name ?? (widgetKind === "markdown" ? "Markdown document" : "Text document")}
      </div>
      <div className="text-document-widget__body" ref={bodyRef}>
        {!loaded && !error ? (
          <Loader2 aria-label="Loading document" className="animate-spin" />
        ) : null}
        {error ? <p className="text-document-widget__status">{error}</p> : null}
        {loaded?.asset.kind === "TEXT" ? (
          <pre className="text-document-widget__plain">{page}</pre>
        ) : null}
        {loaded?.asset.kind === "MARKDOWN" ? (
          <div className="text-document-widget__markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {page}
            </ReactMarkdown>
          </div>
        ) : null}
      </div>
      {loaded ? (
        <div
          className={`text-document-widget__controls${pageCount === 1 ? " text-document-widget__controls--single" : ""}`}
        >
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
      ) : null}
    </div>
  );
};
