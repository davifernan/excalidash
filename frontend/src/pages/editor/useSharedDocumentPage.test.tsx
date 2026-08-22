import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSharedDocumentPage, type DocumentPageSharing } from "./useSharedDocumentPage";

const Reader = ({ sharing, pageCount }: { sharing: DocumentPageSharing; pageCount: number }) => {
  const { page, pending, goToPage } = useSharedDocumentPage({ sharing, pageCount });
  return (
    <div>
      <output data-testid="page">{page}</output>
      <button disabled={pending} onClick={() => goToPage(page + 1)}>
        next
      </button>
      <button disabled={pending} onClick={() => goToPage(page - 1)}>
        previous
      </button>
    </div>
  );
};

const shownPage = () => Number(screen.getByTestId("page").textContent);

describe("the page a document widget shows", () => {
  it("starts on the first page while the room has said nothing", () => {
    render(<Reader sharing={{ elementId: "w", canControl: true }} pageCount={9} />);
    expect(shownPage()).toBe(1);
  });

  it("follows the room", () => {
    const { rerender } = render(
      <Reader sharing={{ elementId: "w", canControl: false }} pageCount={9} />,
    );
    rerender(
      <Reader sharing={{ elementId: "w", canControl: false, sharedPage: 4 }} pageCount={9} />,
    );
    expect(shownPage()).toBe(4);
  });

  it("turns the page for everybody when this reader may edit the board", () => {
    const onRequestPage = vi.fn();
    render(<Reader sharing={{ elementId: "w", canControl: true, onRequestPage }} pageCount={9} />);

    fireEvent.click(screen.getByText("next"));

    // A controller follows the authoritative broadcast. A rejected request
    // therefore never appears as a local page nobody else can see.
    expect(shownPage()).toBe(1);
    expect(onRequestPage).toHaveBeenCalledWith("w", 2);
  });

  it("turns the page only for a reader who may not edit the board", () => {
    const onRequestPage = vi.fn();
    render(<Reader sharing={{ elementId: "w", canControl: false, onRequestPage }} pageCount={9} />);

    fireEvent.click(screen.getByText("next"));

    expect(shownPage()).toBe(2);
    expect(onRequestPage).not.toHaveBeenCalled();
  });

  it("locks an editor's controls until the server answers", async () => {
    let finish!: () => void;
    const onRequestPage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<Reader sharing={{ elementId: "w", canControl: true, onRequestPage }} pageCount={9} />);

    fireEvent.click(screen.getByText("next"));
    expect(screen.getByText("next")).toBeDisabled();
    expect(screen.getByText("previous")).toBeDisabled();
    expect(shownPage()).toBe(1);

    finish();
    await Promise.resolve();
  });

  it("stays inside the document", () => {
    render(<Reader sharing={{ elementId: "w", canControl: false }} pageCount={2} />);
    fireEvent.click(screen.getByText("previous"));
    expect(shownPage()).toBe(1);
    fireEvent.click(screen.getByText("next"));
    fireEvent.click(screen.getByText("next"));
    expect(shownPage()).toBe(2);
  });

  it("clamps a room page this reader cannot reach, and lets go once it can", () => {
    // A text document is split in the browser, so the room can be on a page
    // this reader has not measured yet.
    const { rerender } = render(
      <Reader sharing={{ elementId: "w", canControl: false, sharedPage: 7 }} pageCount={0} />,
    );
    expect(shownPage()).toBe(1);

    rerender(
      <Reader sharing={{ elementId: "w", canControl: false, sharedPage: 7 }} pageCount={12} />,
    );
    expect(shownPage()).toBe(7);
  });
});
