import type { Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Loader2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import type { Components } from "react-markdown";
import { log } from "../../logging";
import { renderMarkdownOffThread } from "./documentMarkdownWorker";

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

export type PreparedMarkdown = { source: string; tree: Root };

export const MarkdownDocumentView = ({
  source,
  prepared,
}: {
  source: string;
  prepared?: PreparedMarkdown | null;
}) => {
  const [rendered, setRendered] = useState<PreparedMarkdown | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);

  useEffect(() => {
    if (prepared?.source === source) {
      setFailedSource(null);
      return;
    }
    const controller = new AbortController();
    setFailedSource(null);
    void renderMarkdownOffThread(source, controller.signal)
      .then((tree) => setRendered({ source, tree }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // The parser can echo document text in an Error.message. The page
        // already shows a stable failure state, so log only the error class.
        log.error(
          "Markdown rendering worker failed",
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          { notify: false },
        );
        setFailedSource(source);
      });
    return () => controller.abort();
  }, [prepared, source]);

  const tree =
    prepared?.source === source
      ? prepared.tree
      : rendered?.source === source
        ? rendered.tree
        : null;
  const content = useMemo<ReactNode>(() => {
    if (!tree) return null;
    return toJsxRuntime(tree, {
      Fragment,
      // The two packages describe the same React component map with separate
      // structural aliases; React 18's ReactNode makes those aliases fail a
      // direct assignment even though this is react-markdown's own renderer.
      components: markdownComponents as unknown as NonNullable<
        Parameters<typeof toJsxRuntime>[1]["components"]
      >,
      ignoreInvalidStyle: true,
      jsx,
      jsxs,
      passKeys: true,
      passNode: true,
    });
  }, [tree]);

  if (failedSource === source) {
    return <p className="text-document-widget__status">Unable to render this page.</p>;
  }
  if (!tree) return <Loader2 aria-label="Rendering Markdown" className="animate-spin" />;

  return <div className="text-document-widget__markdown-content">{content}</div>;
};
