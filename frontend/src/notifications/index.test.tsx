import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stacking } from "../integrations/excalidraw/stacking";

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
  host: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.error,
    warning: mocks.warning,
    success: mocks.success,
    info: mocks.info,
    loading: mocks.loading,
  },
  Toaster: (props: Record<string, unknown>) => {
    mocks.host(props);
    return <div data-testid="notification-host" />;
  },
}));

import { NotificationHost, notify, notifyExcalidrawToast } from ".";

describe("notification facade", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["error", 8_000],
    ["warning", 7_000],
    ["success", 4_000],
    ["info", 5_000],
    ["loading", Number.POSITIVE_INFINITY],
  ] as const)(
    "maps %s severity and its standard duration centrally",
    (severity, duration) => {
      notify(severity, "State changed", { key: "operation", detail: "42%" });

      expect(mocks[severity]).toHaveBeenCalledWith("State changed", {
        description: "42%",
        duration,
        id: "operation",
      });
    },
  );

  it("preserves Excalidraw's single-toast duration and close behavior as info", () => {
    notifyExcalidrawToast({ message: "Nothing selected", duration: 1_250, closable: true });

    expect(mocks.info).toHaveBeenCalledWith("Nothing selected", {
      id: "excalidraw-toast",
      duration: 1_250,
      dismissible: true,
      closeButton: true,
    });
  });

  it("owns stack behavior and takes its layer from the semantic adapter", () => {
    render(<NotificationHost />);

    expect(screen.getByTestId("notification-host")).toBeInTheDocument();
    expect(mocks.host).toHaveBeenCalledWith(
      expect.objectContaining({
        position: "bottom-center",
        richColors: true,
        closeButton: true,
        expand: true,
        visibleToasts: 5,
        className: "excalidash-z-notification",
        style: { zIndex: stacking.notification },
      }),
    );
  });
});
