import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2 } from "lucide-react";
import {
  getPdfAsset,
  getPdfOriginalUrl,
  getPdfPageUrl,
  renameDocumentAsset,
  type PdfAsset,
} from "../../api";
import { useSharedDocumentPage, type DocumentPageSharing } from "./useSharedDocumentPage";
import { ElementFloatingToolbar } from "./ElementFloatingToolbar";
import type { FloatingToolbarTarget } from "./floatingToolbarGeometry";
import { EditableAssetName } from "./EditableAssetName";
import "./PdfWidget.css";

type PdfWidgetProps = {
  assetId: string;
  drawingId: string;
  theme: "light" | "dark";
  canEdit?: boolean;
  sharing: DocumentPageSharing;
  toolbar: FloatingToolbarTarget | null;
};

export const PdfWidget = ({
  assetId,
  drawingId,
  theme,
  canEdit = false,
  sharing,
  toolbar,
}: PdfWidgetProps) => {
  const [asset, setAsset] = useState<PdfAsset | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [displayedPage, setDisplayedPage] = useState<number | null>(null);
  const directionRef = useRef<1 | -1>(1);
  const {
    page: requestedPage,
    pending,
    goToPage,
  } = useSharedDocumentPage({
    sharing,
    pageCount: asset?.pageCount ?? 1,
  });

  useEffect(() => {
    let active = true;
    setAsset(null);
    setMetadataError(null);
    setPageError(null);
    setDisplayedPage(null);
    getPdfAsset(drawingId, assetId)
      .then((nextAsset) => {
        if (!active) return;
        if (!Number.isInteger(nextAsset.pageCount) || nextAsset.pageCount < 1) {
          setMetadataError("This document has no viewable pages.");
          return;
        }
        setAsset(nextAsset);
      })
      .catch(() => {
        if (active) setMetadataError("Unable to load this document.");
      });
    return () => {
      active = false;
    };
  }, [assetId, drawingId]);

  useEffect(() => {
    if (!asset || displayedPage === null) return;
    const nextPage = displayedPage + directionRef.current;
    if (nextPage < 1 || nextPage > asset.pageCount) return;
    const preload = new Image();
    preload.src = getPdfPageUrl(drawingId, assetId, nextPage);
  }, [asset, assetId, displayedPage, drawingId]);

  const turnPage = (direction: 1 | -1) => {
    if (!asset) return;
    directionRef.current = direction;
    setPageError(null);
    goToPage(requestedPage + direction);
  };

  const requestedPageUrl = asset ? getPdfPageUrl(drawingId, assetId, requestedPage) : null;
  const displayedPageUrl = displayedPage ? getPdfPageUrl(drawingId, assetId, displayedPage) : null;

  return (
    <div
      className={`pdf-widget${theme === "dark" ? " pdf-widget--dark" : ""}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="pdf-widget__page">
        {displayedPageUrl && asset ? (
          <img
            className="pdf-widget__page-image"
            src={displayedPageUrl}
            alt={`${asset.name}, page ${displayedPage}`}
            // A page is an image, and an image can be dragged. Dragging one out
            // of the widget dropped it back onto the canvas, where the editor
            // took it for a new upload — so paging through a document quietly
            // created copies of its pages as separate images.
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
          />
        ) : null}
        {requestedPageUrl && displayedPage !== requestedPage ? (
          <img
            className="pdf-widget__page-image pdf-widget__page-image--pending"
            src={requestedPageUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
            onLoad={() => {
              setDisplayedPage(requestedPage);
              setPageError(null);
            }}
            onError={() => setPageError("Unable to load this page.")}
          />
        ) : null}
        {!displayedPage && !metadataError && !pageError ? (
          <Loader2 aria-label="Loading page" className="animate-spin" size={24} />
        ) : null}
        {metadataError ? <p className="pdf-widget__status">{metadataError}</p> : null}
        {pageError ? <p className="pdf-widget__status">{pageError}</p> : null}
      </div>
      {asset ? (
        <ElementFloatingToolbar target={toolbar} label="PDF controls">
          <div className="pdf-widget__controls">
            <EditableAssetName
              name={asset.name}
              canEdit={canEdit}
              onRename={async (name) => {
                const renamed = await renameDocumentAsset(drawingId, assetId, name);
                setAsset((current) => (current ? { ...current, name: renamed.name } : current));
              }}
            />
            <button
              type="button"
              className="pdf-widget__button"
              aria-label="Previous page"
              disabled={pending || requestedPage <= 1}
              onClick={() => turnPage(-1)}
            >
              <ChevronLeft size={18} />
            </button>
            <span className="pdf-widget__page-number">
              Page {requestedPage} of {asset.pageCount}
            </span>
            <button
              type="button"
              className="pdf-widget__button"
              aria-label="Next page"
              disabled={pending || requestedPage >= asset.pageCount}
              onClick={() => turnPage(1)}
            >
              <ChevronRight size={18} />
            </button>
            <a
              className="pdf-widget__button"
              href={getPdfOriginalUrl(drawingId, assetId)}
              download={asset.name}
              aria-label="Download original PDF"
              title="Download original PDF"
            >
              <Download size={17} />
            </a>
          </div>
        </ElementFloatingToolbar>
      ) : null}
    </div>
  );
};
