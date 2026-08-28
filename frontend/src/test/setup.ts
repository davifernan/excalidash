import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

/**
 * jsdom has no FontFace, and Excalidraw registers its own fonts as soon as
 * anything builds an element carrying a label. Without this the export
 * substitute -- the one thing that has to go through that path to become real
 * text rather than a decorative property -- cannot be tested at all.
 *
 * A stub rather than a polyfill: nothing here measures text, and a stub that
 * pretends to load makes the registration a no-op instead of a crash.
 */
class StubFontFace {
  family: string;
  status = "loaded";
  constructor(family: string) {
    this.family = family;
  }
  load() {
    return Promise.resolve(this);
  }
}
(globalThis as Record<string, unknown>).FontFace ??= StubFontFace;
if (typeof document !== "undefined" && !document.fonts) {
  // configurable, so a test that wants its own font stub can still install one.
  // Without it this stub locks the property and the follow integration test
  // fails on redefining it -- a helper that blocks the thing it was helping.
  Object.defineProperty(document, "fonts", {
    writable: true,
    configurable: true,
    value: {
      add: vi.fn(),
      delete: vi.fn(),
      load: vi.fn(() => Promise.resolve([])),
      ready: Promise.resolve(),
    },
  });
}

if (typeof window !== "undefined") {
  URL.createObjectURL = vi.fn(() => "blob:mock-url");
  URL.revokeObjectURL = vi.fn();
}

global.fetch = vi.fn();

/**
 * A canvas that answers.
 *
 * Excalidraw reads a 2d context at module load to find out whether the browser
 * supports canvas filters, and measures every line of text through one. jsdom
 * hands back null for both, so importing the package used to throw before a
 * single test ran. The width returned here is deliberately naive — tests that
 * care about real text layout install their own metrics provider.
 */
const canvasContext = {
  filter: "none",
  font: "",
  measureText: (text: string) => ({ width: text.length }),
};

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() =>
    canvasContext) as unknown as HTMLCanvasElement["getContext"];
}

beforeEach(() => {
  vi.clearAllMocks();
});
