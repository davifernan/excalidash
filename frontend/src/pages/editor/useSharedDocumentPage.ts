import { useCallback, useEffect, useState } from "react";

export type DocumentPageSharing = {
  /** The board element this widget is drawn into; what the room keys a page by. */
  elementId: string;
  /** The page the room is on, once the server has said so. */
  sharedPage?: number;
  /** Whether a page turn here is everybody's, or only this reader's. */
  canControl: boolean;
  onRequestPage?: (elementId: string, page: number) => Promise<unknown> | void;
};

const clamp = (page: number, pageCount: number) =>
  Math.min(Math.max(1, page), Math.max(1, pageCount));

/**
 * The page a document widget shows.
 *
 * Everyone follows the room: whenever the shared page moves, every widget
 * follows it, whether or not that reader may turn pages themselves. The
 * difference is what a click does. Someone who may edit the board turns the
 * page for the room; someone who may only look turns it for themselves, so a
 * read-only link is still a readable document rather than a fixed first page.
 *
 * Editors never apply their own request. The page changes only when the server
 * broadcasts the accepted revision, so a refusal cannot leave this one reader
 * on a page nobody else sees. Read-only navigation remains deliberately local.
 */
export const useSharedDocumentPage = ({
  sharing,
  pageCount,
}: {
  sharing: DocumentPageSharing;
  pageCount: number;
}) => {
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState(false);
  const { canControl, elementId, onRequestPage, sharedPage } = sharing;

  useEffect(() => {
    if (sharedPage === undefined) return;
    setPage(clamp(sharedPage, pageCount));
  }, [pageCount, sharedPage]);

  const goToPage = useCallback(
    (next: number) => {
      const wanted = clamp(next, pageCount);
      if (!canControl) {
        setPage(wanted);
        return;
      }
      if (pending || !onRequestPage) return;
      setPending(true);
      try {
        void Promise.resolve(onRequestPage(elementId, wanted)).finally(() => setPending(false));
      } catch {
        setPending(false);
      }
    },
    [canControl, elementId, onRequestPage, pageCount, pending],
  );

  return { page, pending, goToPage };
};
