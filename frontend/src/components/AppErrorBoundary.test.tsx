import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

const Boom = (): JSX.Element => {
  throw new Error("render exploded");
};

/** Renders a handled failure state instead of throwing, the way NIL-262 left it. */
const HandledFailure = (): JSX.Element => <p>Could not load drawings. Try again.</p>;

/**
 * Throws while the flag is set. A counter that decrements on render is not
 * usable here: React re-renders a throwing tree synchronously to collect the
 * component stack, so the second attempt would silently succeed.
 */
let shouldThrow = false;
const FlakyChild = (): JSX.Element => {
  if (shouldThrow) throw new Error("transient");
  return <p>drawings loaded</p>;
};

describe("AppErrorBoundary", () => {
  beforeEach(() => {
    // React itself logs every caught error; silencing keeps the assertions readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a failure instead of an empty document when a child throws", () => {
    const { container } = render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/something broke on this screen/i)).toBeInTheDocument();
    expect(container.textContent?.trim()).not.toBe("");
  });

  it("prints a reference that matches the one it logged", () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    const reference = screen.getByText(/^[0-9a-f]{8}$/i).textContent;
    expect(reference).toBeTruthy();

    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
      (call: unknown[]) => typeof call[0] === "string" && call[0] === `[crash ${reference}]`,
    );
    expect(logged).toBe(true);
  });

  it("does not leak the technical message into the interface", () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    expect(screen.queryByText(/render exploded/)).not.toBeInTheDocument();
  });

  it("gives the application back after Try again, without a reload", () => {
    shouldThrow = true;

    render(
      <AppErrorBoundary>
        <FlakyChild />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByText("drawings loaded")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("leaves a handled failure state alone", () => {
    render(
      <AppErrorBoundary>
        <HandledFailure />
      </AppErrorBoundary>,
    );

    expect(screen.getByText(/could not load drawings/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
