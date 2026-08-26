import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyApiMethods, verifyCssSelectors, verifySelectors } from "./seams";
import { buildElements } from "../elements";

vi.hoisted(() => {
  class TestPath2D {}
  (globalThis as Record<string, unknown>).Path2D = TestPath2D;

  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      add: vi.fn(),
      delete: vi.fn(),
      has: vi.fn(() => true),
      check: vi.fn(() => true),
      load: vi.fn(() => Promise.resolve([])),
      ready: Promise.resolve(),
    },
  });

  const context = {
    filter: "none",
    font: "",
    measureText: (text: string) => ({
      width: text.length * 8,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    }),
  };
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    return new Proxy(
      { ...context, canvas: this },
      {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return vi.fn();
        },
        set(target, property, value) {
          (target as Record<PropertyKey, unknown>)[property] = value;
          return true;
        },
      },
    );
  }) as never;
});

type RenderedEditor = {
  api: Record<string, unknown>;
  container: HTMLElement;
  unmount: () => void;
};

const rect = (width: number, height: number): DOMRect =>
  ({
    bottom: height,
    height,
    left: 0,
    right: width,
    top: 0,
    width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;

const renderEditor = async (
  width: number,
  height: number,
  props: Record<string, unknown> = {},
): Promise<RenderedEditor> => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(width, height));
  let api: Record<string, unknown> | undefined;
  const view = render(
    <div style={{ width, height }}>
      <Excalidraw
        {...props}
        excalidrawAPI={(value) => {
          api = value as unknown as Record<string, unknown>;
        }}
      />
    </div>,
  );
  await waitFor(() => expect(api).toBeDefined());
  await waitFor(() => expect(view.container.querySelector(".excalidraw")).not.toBeNull());
  return { api: api!, container: view.container, unmount: view.unmount };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the installed package rendered as an editor", () => {
  it("matches every selector in the layout state where ExcaliDash consumes it", async () => {
    const desktop = await renderEditor(900, 600);
    expect(
      verifySelectors(desktop.container, [
        "root",
        "toolbar",
        "toolbarRow",
        "chrome",
        "interactiveCanvas",
      ]),
    ).toEqual([]);

    await act(async () => {
      (desktop.api.updateScene as (change: unknown) => void)({
        appState: { zenModeEnabled: true },
      });
    });
    await waitFor(() => expect(verifySelectors(desktop.container, ["zenMode"])).toEqual([]));
    desktop.unmount();

    const mobile = await renderEditor(375, 700);
    await waitFor(() => expect(verifySelectors(mobile.container, ["mobile"])).toEqual([]));
    mobile.unmount();
  });

  it("calls every imperative method and accepts the shapes the adapter consumes", async () => {
    const editor = await renderEditor(900, 600);
    let incompatible: string[] = [];
    await act(async () => {
      incompatible = await verifyApiMethods(editor.api);
    });
    expect(incompatible).toEqual([]);
    editor.unmount();
  });

  it("matches every foreign CSS selector where ExcaliDash uses it", async () => {
    const editor = await renderEditor(900, 600, {
      isCollaborating: true,
      renderTopRightUI: () => <div className="editor-header-controls" />,
    });

    await act(async () => {
      (editor.api.updateScene as (change: unknown) => void)({
        collaborators: new Map([["css-seam-peer", { username: "CSS seam peer" }]]),
      });
    });

    await waitFor(() =>
      expect(
        verifyCssSelectors(editor.container, [
          "topRight",
          "collaboratorWrapper",
          "collaboratorList",
          "libraryTrigger",
          "mainMenuTrigger",
          "helpIcon",
          "collaborationLaserIsland",
        ]),
      ).toEqual([]),
    );

    const extraTools = editor.container.querySelector<HTMLElement>(
      ".App-toolbar__extra-tools-trigger",
    );
    expect(extraTools).not.toBeNull();
    fireEvent.click(extraTools!);
    await waitFor(() =>
      expect(verifyCssSelectors(editor.container, ["extraToolsLaser"])).toEqual([]),
    );

    const [baseWidget] = buildElements([
      { type: "rectangle", x: 100, y: 100, width: 200, height: 100 },
    ]);
    const widget = {
      ...baseWidget,
      type: "embeddable" as const,
      link: "excalidash://css-seam-widget",
    };
    await act(async () => {
      (editor.api.updateScene as (change: unknown) => void)({
        elements: [widget],
        appState: {
          selectedElementIds: { [widget.id]: true },
          showHyperlinkPopup: "info",
        },
      });
    });
    await waitFor(() =>
      expect(verifyCssSelectors(editor.container, ["widgetHyperlink"])).toEqual([]),
    );
    editor.unmount();
  });

  it("rejects a real handle when a read method keeps its name but becomes asynchronous", async () => {
    const editor = await renderEditor(900, 600);
    const originalGetAppState = editor.api.getAppState as () => unknown;
    const changedHandle = new Proxy(editor.api, {
      get(target, property, receiver) {
        if (property === "getAppState") return () => Promise.resolve(originalGetAppState());
        return Reflect.get(target, property, receiver);
      },
    });
    let incompatible: string[] = [];
    await act(async () => {
      incompatible = await verifyApiMethods(changedHandle);
    });
    expect(incompatible).toContain("getAppState");
    editor.unmount();
  });
});
