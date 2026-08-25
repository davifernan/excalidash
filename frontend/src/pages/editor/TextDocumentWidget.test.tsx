import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDocumentAsset, getDocumentContent, renameDocumentAsset } from "../../api";
import { TextDocumentWidget } from "./TextDocumentWidget";

const { paginateDocumentSourceMock } = vi.hoisted(() => ({
  paginateDocumentSourceMock: vi.fn(),
}));

const { paginateDocumentOffThreadMock } = vi.hoisted(() => ({
  paginateDocumentOffThreadMock: vi.fn(),
}));

vi.mock("./documentPagination", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./documentPagination")>();
  return {
    ...actual,
    paginateDocumentSource: (...args: Parameters<typeof actual.paginateDocumentSource>) => {
      paginateDocumentSourceMock(...args);
      return actual.paginateDocumentSource(...args);
    },
  };
});

vi.mock("./documentPaginationWorker", async () => {
  const actual =
    await vi.importActual<typeof import("./documentPagination")>("./documentPagination");
  paginateDocumentOffThreadMock.mockImplementation(
    async (source: string, kind: "MARKDOWN" | "TEXT") =>
      actual.paginateDocumentSource(source, kind),
  );
  return { paginateDocumentOffThread: paginateDocumentOffThreadMock };
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
  getDocumentOriginalUrl: (drawingId: string, assetId: string) =>
    `/api/drawings/${drawingId}/assets/${assetId}/original`,
}));

describe("TextDocumentWidget", () => {
  beforeEach(() => {
    vi.mocked(getDocumentAsset).mockResolvedValue({
      id: "asset-1",
      kind: "MARKDOWN",
      name: "notes.md",
      sizeBytes: 100,
      pageCount: null,
    });
    vi.mocked(renameDocumentAsset).mockResolvedValue({
      id: "asset-1",
      kind: "MARKDOWN",
      name: "renamed.md",
      sizeBytes: 100,
      pageCount: null,
    });
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
    expect(screen.getByRole("heading", { name: "Second page" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "First page" })).toBeNull();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
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
    expect(screen.getByRole("link", { name: "Download original document" })).toHaveAttribute(
      "href",
      "/api/drawings/drawing-1/assets/asset-1/original",
    );
  }, 10_000);
});
