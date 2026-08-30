import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Root } from "hast";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDocumentAsset,
  getDocumentContent,
  renameDocumentAsset,
  replaceMarkdownContent,
} from "../../api";
import { TextDocumentWidget } from "./TextDocumentWidget";

const { paginateDocumentOffThreadMock } = vi.hoisted(() => ({
  paginateDocumentOffThreadMock: vi.fn(),
}));

const { renderMarkdownOffThreadMock } = vi.hoisted(() => ({
  renderMarkdownOffThreadMock: vi.fn(),
}));

const { paginateDocumentSourceMock } = vi.hoisted(() => ({
  paginateDocumentSourceMock: vi.fn(),
}));

// NIL-624 moved this function into @excalidash/domain/documents, shared by
// both runtimes; main's own version of this spy wrapped the old local
// ./documentPagination module before that move.
vi.mock("@excalidash/domain/documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@excalidash/domain/documents")>();
  return {
    ...actual,
    paginateDocumentSource: (...args: Parameters<typeof actual.paginateDocumentSource>) => {
      paginateDocumentSourceMock(...args);
      return actual.paginateDocumentSource(...args);
    },
  };
});

vi.mock("./documentPaginationWorker", async () => {
  const actual = await vi.importActual<typeof import("@excalidash/domain/documents")>(
    "@excalidash/domain/documents",
  );
  paginateDocumentOffThreadMock.mockImplementation(
    async (source: string, kind: "MARKDOWN" | "TEXT") =>
      actual.paginateDocumentSource(source, kind),
  );
  return { paginateDocumentOffThread: paginateDocumentOffThreadMock };
});

vi.mock("./documentMarkdownWorker", async () => {
  const actual = await vi.importActual<typeof import("./documentMarkdown")>("./documentMarkdown");
  renderMarkdownOffThreadMock.mockImplementation(async (source: string) =>
    actual.prepareMarkdownForRender(source),
  );
  return { renderMarkdownOffThread: renderMarkdownOffThreadMock };
});

// A widget that is not sharing its page with anybody: the same object every
// render, so the shared-page effect does not refire on its own.
const soloSharing = {
  elementId: "widget-1",
  assetId: "asset-1",
  canControl: false,
} as const;

const toolbar = {
  host: document.body,
  anchor: { left: 200, top: 200, right: 720, bottom: 760 },
};

vi.mock("../../api", () => ({
  getDocumentAsset: vi.fn(),
  getDocumentContent: vi.fn(),
  renameDocumentAsset: vi.fn(),
  replaceMarkdownContent: vi.fn(),
  getDocumentOriginalUrl: (drawingId: string, assetId: string) =>
    `/api/drawings/${drawingId}/assets/${assetId}/original`,
}));

describe("TextDocumentWidget", () => {
  beforeEach(() => {
    paginateDocumentOffThreadMock.mockClear();
    paginateDocumentSourceMock.mockClear();
    renderMarkdownOffThreadMock.mockClear();
    vi.mocked(getDocumentAsset).mockResolvedValue({
      id: "asset-1",
      kind: "MARKDOWN",
      name: "notes.md",
      sizeBytes: 100,
      pageCount: null,
      revision: "a".repeat(64),
    });
    vi.mocked(renameDocumentAsset).mockResolvedValue({
      id: "asset-1",
      kind: "MARKDOWN",
      name: "renamed.md",
      sizeBytes: 100,
      pageCount: null,
    });
  });

  it("edits and saves the complete Markdown source from the floating toolbar", async () => {
    vi.mocked(getDocumentContent).mockResolvedValue("# Original");
    vi.mocked(replaceMarkdownContent).mockResolvedValue({
      id: "asset-2",
      kind: "MARKDOWN",
      name: "notes.md",
      sizeBytes: 20,
      pageCount: null,
      revision: "b".repeat(64),
      drawingVersion: 4,
      elements: [{ id: "widget-1" }, { id: "widget-copy" }],
    });
    const acquire = vi.fn(async () => ({ ok: true as const, token: "lock-token" }));
    const release = vi.fn();
    const drainPendingSceneSave = vi.fn(async () => {});
    const applyReplacement = vi.fn(() => true);
    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        canEdit
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
        onAcquireEditLock={acquire}
        onReleaseEditLock={release}
        onBeforeDocumentAssetReplacement={drainPendingSceneSave}
        onDocumentAssetReplacement={applyReplacement}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown source" });
    expect(editor).toHaveValue("# Original");
    fireEvent.change(editor, { target: { value: "# Persisted\n\nNew text." } });
    fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));

    await waitFor(() =>
      expect(replaceMarkdownContent).toHaveBeenCalledWith(
        "drawing-1",
        "asset-1",
        "widget-1",
        "# Persisted\n\nNew text.",
        "a".repeat(64),
        "lock-token",
      ),
    );
    expect(drainPendingSceneSave).toHaveBeenCalledBefore(replaceMarkdownContent);
    expect(applyReplacement).toHaveBeenCalledWith({
      drawingId: "drawing-1",
      previousAssetId: "asset-1",
      assetId: "asset-2",
      drawingVersion: 4,
      elements: [{ id: "widget-1" }, { id: "widget-copy" }],
    });
    expect(screen.queryByRole("textbox", { name: "Markdown source" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "Persisted" })).toBeInTheDocument();
  });

  it("renders a live preview beside the source while typing, without switching modes (NIL-583)", async () => {
    vi.mocked(getDocumentContent).mockResolvedValue("# Original");
    const acquire = vi.fn(async () => ({ ok: true as const, token: "lock-token" }));
    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        canEdit
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
        onAcquireEditLock={acquire}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown source" });
    const preview = screen.getByLabelText("Markdown preview");

    // Editing mode itself, not a mode switch, is what produces the preview.
    expect(editor).toBeInTheDocument();
    expect(preview).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "# Original\n\nThis is **bold**." } });

    await waitFor(() => expect(preview.querySelector("strong")).toHaveTextContent("bold"));
    // Still in editing mode: the textarea is what the test just typed into,
    // not what was loaded -- nobody toggled to view mode to see the render.
    expect(editor).toHaveValue("# Original\n\nThis is **bold**.");
  });

  it("publishes the initial and changed draft, then explicitly rolls spectators back on cancel", async () => {
    vi.mocked(getDocumentContent).mockResolvedValue("# Saved");
    const acquire = vi.fn(async () => ({ ok: true as const, token: "lock-token" }));
    const beginLive = vi.fn();
    const updateLive = vi.fn();
    const cancelLive = vi.fn();
    const release = vi.fn();
    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        canEdit
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
        onAcquireEditLock={acquire}
        onReleaseEditLock={release}
        onBeginLiveDraft={beginLive}
        onUpdateLiveDraft={updateLive}
        onCancelLiveDraft={cancelLive}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    await screen.findByRole("textbox", { name: "Markdown source" });
    expect(beginLive).toHaveBeenCalledWith("lock-token", "# Saved");
    fireEvent.change(screen.getByRole("textbox", { name: "Markdown source" }), {
      target: { value: "# Unsaved live" },
    });
    expect(updateLive).toHaveBeenCalledWith("# Unsaved live");
    fireEvent.click(screen.getByRole("button", { name: "Cancel Markdown editing" }));
    expect(cancelLive).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("lock-token");
    expect(await screen.findByRole("heading", { name: "Saved" })).toBeVisible();
  });

  it("renders a remote live draft for a locked spectator without replacing saved content", async () => {
    vi.mocked(getDocumentContent).mockResolvedValue("# Saved");
    const { rerender } = render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        canEdit
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
        editLock={{ assetId: "asset-1", presenceId: "writer", ownerName: "Alice" }}
        liveDraft={{
          assetId: "asset-1",
          presenceId: "writer",
          revision: 2,
          content: "# Unsaved live",
        }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Unsaved live" })).toBeVisible();
    rerender(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        canEdit
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Saved" })).toBeVisible();
  });

  it("keeps textarea focus while a formatting button changes the selection", async () => {
    vi.mocked(getDocumentContent).mockResolvedValue("Make this bold");
    const acquire = vi.fn(async () => ({ ok: true as const, token: "lock-token" }));
    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        canEdit
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
        onAcquireEditLock={acquire}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    const editor = (await screen.findByRole("textbox", {
      name: "Markdown source",
    })) as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(5, 9);
    const bold = screen.getByRole("button", { name: "Bold" });
    fireEvent.pointerDown(bold);
    fireEvent.click(bold);

    await waitFor(() => expect(editor).toHaveValue("Make **this** bold"));
    expect(document.activeElement).toBe(editor);
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([7, 11]);
  });

  it("sanitizes the live edit preview exactly like the view-mode render (NIL-583)", async () => {
    vi.mocked(getDocumentContent).mockResolvedValue("# Original");
    const acquire = vi.fn(async () => ({ ok: true as const, token: "lock-token" }));
    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        canEdit
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
        onAcquireEditLock={acquire}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown source" });
    const preview = screen.getByLabelText("Markdown preview");

    fireEvent.change(editor, {
      target: {
        value: [
          '<script>window.pwned = true</script><b onclick="alert(1)">raw</b>',
          "",
          "[bad](javascript:alert(1)) [web](https://example.com)",
        ].join("\n"),
      },
    });

    await waitFor(() => expect(preview.querySelector("a")).not.toBeNull());
    // The uploaded-file content types into this pane on every keystroke while
    // the file is still being edited -- it must never render a live script
    // tag, an inline event handler, or a javascript: URL, exactly like the
    // already-audited view-mode render (see the "renders GFM without raw
    // HTML" test above; same markdownComponents pipeline, see NIL-583's
    // design-decision comment on the ticket for why that reuse is the point).
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.querySelector("b")).toBeNull();
    expect(within(preview).getByText("bad").closest("a")).not.toHaveAttribute("href");
    expect(within(preview).getByRole("link", { name: "web" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
  });

  it("names the other editor and prevents a second browser from entering edit mode", async () => {
    vi.mocked(getDocumentContent).mockResolvedValue("# Locked");
    const acquire = vi.fn();
    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        canEdit
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
        editLock={{ assetId: "asset-1", presenceId: "peer", ownerName: "Alice" }}
        onAcquireEditLock={acquire}
      />,
    );

    expect(await screen.findByText("Editing: Alice")).toBeVisible();
    const button = screen.getByRole("button", { name: "Edit Markdown" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("renames the document from the floating toolbar", async () => {
    vi.mocked(getDocumentContent).mockResolvedValue("# Notes");
    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        canEdit
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Rename notes.md" }));
    const input = screen.getByRole("textbox", { name: "Document filename" });
    fireEvent.change(input, { target: { value: "renamed.md" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() =>
      expect(renameDocumentAsset).toHaveBeenCalledWith("drawing-1", "asset-1", "renamed.md"),
    );
    expect(await screen.findByRole("button", { name: "Rename renamed.md" })).toBeVisible();
  });

  it("separates the filename from the content actions with a divider (NIL-582)", async () => {
    vi.mocked(getDocumentContent).mockResolvedValue("# Notes");
    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        canEdit
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );
    await screen.findByRole("toolbar", { name: "Document controls" });

    // The controls portal onto `toolbar.host` (document.body here), not into
    // the render container.
    const controls = document.body.querySelector(".element-floating-toolbar__row");
    const children = controls ? Array.from(controls.children) : [];
    const nameIndex = children.findIndex((child) =>
      child.matches(".editable-asset-name__button, .editable-asset-name__label"),
    );
    const dividerIndex = children.findIndex((child) =>
      child.matches(".element-floating-toolbar__divider"),
    );
    const actionsIndex = children.findIndex((child) =>
      child.matches(".element-floating-toolbar__actions"),
    );

    // The pencil sits in the identity group in the DOM; only the divider
    // between it and the content-action group states that they are two
    // different kinds of thing (NIL-582). A regression that drops the
    // divider, or interleaves it with the wrong group, must fail here.
    expect(nameIndex).toBe(0);
    expect(dividerIndex).toBe(1);
    expect(actionsIndex).toBe(2);
    expect(
      controls
        ?.querySelector(".element-floating-toolbar__actions")
        ?.contains(screen.getByRole("button", { name: "Edit Markdown" })),
    ).toBe(true);
  });

  it("renders GFM without raw HTML and permits only hardened web and mail links", async () => {
    vi.mocked(getDocumentContent).mockResolvedValue(
      [
        "# Notes",
        "",
        '<script>window.pwned = true</script><b onclick="alert(1)">raw</b>',
        "",
        "[bad](javascript:alert(1)) [relative](/private) [web](https://example.com) [mail](mailto:a@example.com)",
        "",
        "| A | B |",
        "| - | - |",
        "| one | `two` |",
      ].join("\n"),
    );
    const { container } = render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    await screen.findByText("Notes");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("bad").closest("a")).not.toHaveAttribute("href");
    expect(screen.getByText("relative").closest("a")).not.toHaveAttribute("href");
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "mail" })).toHaveAttribute(
      "href",
      "mailto:a@example.com",
    );
    expect(container.querySelector("table code")).toHaveTextContent("two");
  });

  it("renders plain text literally with preserved whitespace", async () => {
    vi.mocked(getDocumentAsset).mockResolvedValue({
      id: "asset-1",
      kind: "TEXT",
      name: "notes.txt",
      sizeBytes: 40,
      pageCount: null,
    });
    vi.mocked(getDocumentContent).mockResolvedValue("first line\n  <b>literal</b>");
    const { container } = render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        widgetKind="text"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    const plain = await screen.findByText(/first line/);
    expect(plain.tagName).toBe("PRE");
    expect(plain.textContent).toBe("first line\n  <b>literal</b>");
    expect(container.querySelector("b")).toBeNull();
    expect(screen.queryByText(/Page 1 of/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
    expect(screen.getByRole("link", { name: "Download original document" })).toBeInTheDocument();
  });

  it("hands pagination to a worker instead of running the algorithm during UI render", async () => {
    vi.mocked(getDocumentContent).mockResolvedValue("# Responsive\n\nA document body.");

    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    await screen.findByRole("heading", { name: "Responsive" });
    expect(paginateDocumentOffThreadMock).toHaveBeenCalledWith(
      "# Responsive\n\nA document body.",
      "MARKDOWN",
      expect.any(AbortSignal),
    );
    // The test's own name is the promise this line holds it to: pagination
    // must go through the worker, never the synchronous algorithm directly.
    // Lost during an earlier merge -- the mock was still wired (created,
    // called from inside the worker mock, reset in beforeEach) but never
    // actually asked whether the synchronous path ran, which would have let
    // this test stay green even if that promise were broken again.
    expect(paginateDocumentSourceMock).not.toHaveBeenCalled();
  });

  it("shows a stable error when the pagination worker fails", async () => {
    paginateDocumentOffThreadMock.mockRejectedValueOnce(new Error("worker crashed"));
    vi.mocked(getDocumentContent).mockResolvedValue("# Unavailable");

    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    expect(await screen.findByText("Unable to prepare this document.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Unavailable" })).toBeNull();
  });

  it("publishes page controls before a slow Markdown rendering worker resolves", async () => {
    let resolveMarkdown: ((tree: Root) => void) | undefined;
    renderMarkdownOffThreadMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMarkdown = resolve;
        }),
    );
    const first = `# First page\n\n${"first ".repeat(2_500)}`;
    const second = `# Second page\n\n${"second ".repeat(2_500)}`;
    vi.mocked(getDocumentContent).mockResolvedValue(`${first}\n\n${second}`);

    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Rendering Markdown")).toBeInTheDocument();

    const actual = await vi.importActual<typeof import("./documentMarkdown")>("./documentMarkdown");
    resolveMarkdown?.(actual.prepareMarkdownForRender(first));
    expect(await screen.findByRole("heading", { name: "First page" })).toBeInTheDocument();
  });

  it("shows the Markdown worker failure after page controls are available", async () => {
    renderMarkdownOffThreadMock.mockRejectedValueOnce(new Error("worker crashed"));
    const first = `# Unavailable\n\n${"first ".repeat(2_500)}`;
    const second = `# Second page\n\n${"second ".repeat(2_500)}`;
    vi.mocked(getDocumentContent).mockResolvedValue(`${first}\n\n${second}`);

    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    expect(await screen.findByText("Unable to render this page.")).toBeInTheDocument();
  });

  it("shows the correct page count and changes the rendered source when paging", async () => {
    const first = `# First page\n\n${"first ".repeat(2_500)}`;
    const second = `# Second page\n\n${"second ".repeat(2_500)}`;
    vi.mocked(getDocumentContent).mockResolvedValue(`${first}\n\n${second}`);
    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "First page" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Second page" })).toBeNull();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Second page" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "First page" })).toBeNull();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("shows a stable page error without logging worker input when later-page parsing fails", async () => {
    const first = `# First page\n\n${"first ".repeat(2_500)}`;
    const second = `# Secret LEAKME42\n\n${"second ".repeat(2_500)}`;
    vi.mocked(getDocumentContent).mockResolvedValue(`${first}\n\n${second}`);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const actual = await vi.importActual<typeof import("./documentMarkdown")>("./documentMarkdown");
    renderMarkdownOffThreadMock.mockImplementation(async (source: string) => {
      if (source.includes("LEAKME42")) throw new SyntaxError("LEAKME42 is not valid Markdown");
      return actual.prepareMarkdownForRender(source);
    });

    render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(await screen.findByText("Unable to render this page.")).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledOnce();
    const logLine = String(consoleError.mock.calls[0]?.[0]);
    expect(logLine).not.toContain("LEAKME42");
    expect(logLine).toContain('"errorName":"SyntaxError"');
    consoleError.mockRestore();
  });

  it("only parses the current page of a pathological 500,000-row table", async () => {
    const rows = "| cell |\n".repeat(500_000);
    vi.mocked(getDocumentContent).mockResolvedValue(`| Value |\n| --- |\n${rows}`);
    const started = performance.now();
    const { container } = render(
      <TextDocumentWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        widgetKind="markdown"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    expect(await screen.findByText("Page 1 of 226")).toBeInTheDocument();
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(container.querySelectorAll("tbody tr").length).toBeLessThan(3_000);
    expect(renderMarkdownOffThreadMock).toHaveBeenCalledOnce();
    const parsedSource = renderMarkdownOffThreadMock.mock.calls[0]?.[0];
    expect(parsedSource).not.toBe(`| Value |\n| --- |\n${rows}`);
    expect(parsedSource.length).toBeLessThanOrEqual(20_000);
    expect(screen.getByRole("link", { name: "Download original document" })).toHaveAttribute(
      "href",
      "/api/drawings/drawing-1/assets/asset-1/original",
    );
  }, 10_000);
});
