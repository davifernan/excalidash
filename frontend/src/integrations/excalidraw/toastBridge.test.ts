import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyExcalidrawToast = vi.hoisted(() => vi.fn());
vi.mock("../../notifications", () => ({ notifyExcalidrawToast }));

import { createExcalidrawToastForwarder } from "./toastBridge";

describe("Excalidraw toast bridge", () => {
  beforeEach(() => notifyExcalidrawToast.mockClear());

  it("forwards one upstream toast once despite unrelated repeated app-state changes", () => {
    const forward = createExcalidrawToastForwarder();
    const upstream = { message: "Nothing selected", closable: true, duration: 1_250 };

    forward(upstream);
    forward({ ...upstream });

    expect(notifyExcalidrawToast).toHaveBeenCalledTimes(1);
    expect(notifyExcalidrawToast).toHaveBeenCalledWith(upstream);
  });

  it("accepts the same message again after Excalidraw clears its toast", () => {
    const forward = createExcalidrawToastForwarder();
    const upstream = { message: "Nothing selected" };

    forward(upstream);
    forward(null);
    forward(upstream);

    expect(notifyExcalidrawToast).toHaveBeenCalledTimes(2);
  });
});
