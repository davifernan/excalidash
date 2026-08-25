import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPdfAsset, getPdfPageUrl } from "../../api";
import { PdfWidget } from "./PdfWidget";

// A widget that is not sharing its page with anybody: the same object every
// render, so the shared-page effect does not refire on its own.
const soloSharing = {
  elementId: "widget-1",
  assetId: "asset-1",
  canControl: false,
} as const;

const toolbar = {
  host: document.body,
  anchor: { left: 200, top: 200, right: 680, bottom: 880 },
};

vi.mock("../../api", () => ({
  getPdfAsset: vi.fn(),
  getPdfOriginalUrl: (drawingId: string, assetId: string) =>
    `/api/drawings/${drawingId}/assets/${assetId}/original`,
  getPdfPageUrl: vi.fn(
    (drawingId: string, assetId: string, page: number) =>
      `/api/drawings/${drawingId}/assets/${assetId}/pages/${page}`,
  ),
}));

const asset = {
  id: "asset-1",
  kind: "PDF" as const,
  name: "Project brief.pdf",
  sizeBytes: 12_345,
  pageCount: 3,
};

const loadPendingPage = (container: HTMLElement) => {
  const pending = container.querySelector<HTMLImageElement>(".pdf-widget__page-image--pending");
  expect(pending).not.toBeNull();
  fireEvent.load(pending!);
};

describe("PdfWidget", () => {
  beforeEach(() => {
    vi.mocked(getPdfAsset).mockResolvedValue(asset);
  });

  it("keeps the previous page visible while switching pages", async () => {
    const { container } = render(
      <PdfWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
    loadPendingPage(container);
    expect(await screen.findByAltText("Project brief.pdf, page 1")).toHaveAttribute(
      "src",
      expect.stringContaining("/pages/1"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    expect(screen.getByAltText("Project brief.pdf, page 1")).toBeInTheDocument();
    loadPendingPage(container);

    expect(await screen.findByAltText("Project brief.pdf, page 2")).toHaveAttribute(
      "src",
      expect.stringContaining("/pages/2"),
    );
    expect(screen.queryByAltText("Project brief.pdf, page 1")).not.toBeInTheDocument();
  });

  it("disables navigation at the first and last page", async () => {
    const { container } = render(
      <PdfWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    await screen.findByText("Page 1 of 3");
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    const next = screen.getByRole("button", { name: "Next page" });
    fireEvent.click(next);
    loadPendingPage(container);
    fireEvent.click(next);
    loadPendingPage(container);

    await waitFor(() => expect(screen.getByText("Page 3 of 3")).toBeInTheDocument());
    expect(next).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).not.toBeDisabled();
  });

  it("renders document pages as images rather than inline documents", async () => {
    const { container } = render(
      <PdfWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    await screen.findByText("Page 1 of 3");
    loadPendingPage(container);
    await screen.findByAltText("Project brief.pdf, page 1");
    const page = container.querySelector(".pdf-widget__page");
    expect(page?.querySelector("img")).toBeInTheDocument();
    expect(page?.querySelector("iframe, embed, object, svg")).toBeNull();
    expect(getPdfPageUrl).toHaveBeenCalledWith("drawing-1", "asset-1", 1);
  });

  it("portals controls out of the scaled widget and hides them without a sole selection", async () => {
    const { container, rerender } = render(
      <PdfWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        sharing={soloSharing}
        toolbar={toolbar}
      />,
    );

    expect(await screen.findByRole("toolbar", { name: "PDF controls" })).toBeInTheDocument();
    expect(container.querySelector(".pdf-widget__controls")).toBeNull();

    rerender(
      <PdfWidget
        assetId="asset-1"
        drawingId="drawing-1"
        theme="light"
        sharing={soloSharing}
        toolbar={null}
      />,
    );
    expect(screen.queryByRole("toolbar", { name: "PDF controls" })).toBeNull();
  });
});
