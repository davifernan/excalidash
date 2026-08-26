import { describe, expect, it } from "vitest";
import { applyMarkdownFormat } from "./markdownFormatting";

describe("Markdown formatting actions", () => {
  it("wraps a selection and keeps the selected text selected", () => {
    expect(applyMarkdownFormat("make this bold", 5, 9, "bold")).toEqual({
      value: "make **this** bold",
      selectionStart: 7,
      selectionEnd: 11,
    });
  });

  it("prefixes every selected line as a list", () => {
    expect(applyMarkdownFormat("one\ntwo", 0, 7, "list").value).toBe("- one\n- two");
  });

  it("turns selected words into a link and selects the URL", () => {
    expect(applyMarkdownFormat("Open docs", 5, 9, "link")).toEqual({
      value: "Open [docs](https://)",
      selectionStart: 12,
      selectionEnd: 20,
    });
  });
});
