import { describe, expect, it } from "vitest";
import { DOCUMENT_PAGE_CHAR_BUDGET, paginateDocumentSource } from "./documentPagination";

describe("document source pagination", () => {
  it("never cuts a fenced code block at a page boundary", () => {
    const fence = `\`\`\`ts\n${"const value = 1;\n".repeat(8)}\`\`\`\n`;
    const source = `${"intro ".repeat(8)}\n\n${fence}\nAfter the fence.`;

    const pages = paginateDocumentSource(source, "MARKDOWN", 80);

    expect(pages).toHaveLength(3);
    expect(pages.filter((page) => page.includes("const value"))).toEqual([fence]);
    expect(pages.some((page) => page.startsWith("```ts") && page.endsWith("```\n"))).toBe(true);
  });

  it("repeats a table header and separator when a table spans pages", () => {
    const prefix = "| Name | Value |\n| --- | ---: |\n";
    const rows = Array.from({ length: 12 }, (_, index) => `| row ${index} | ${index} |\n`).join("");

    const pages = paginateDocumentSource(prefix + rows, "MARKDOWN", 100);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.startsWith(prefix))).toBe(true);
    expect(pages.join("\n")).toContain("| row 11 | 11 |");
  });

  it("keeps an oversized block on one non-empty page", () => {
    const source = `~~~text\n${"one very long code line ".repeat(40)}\n~~~`;

    const pages = paginateDocumentSource(source, "MARKDOWN", 80);

    expect(pages).toEqual([source]);
    expect(pages.every((page) => page.length > 0)).toBe(true);
  });

  it("does not create a blank page before an oversized block", () => {
    const fence = `\`\`\`\n${"large block\n".repeat(20)}\`\`\``;
    const source = `${"x".repeat(80)}\n\n${fence}`;

    const pages = paginateDocumentSource(source, "MARKDOWN", 80);

    expect(pages).toEqual([`${"x".repeat(80)}\n`, fence]);
    expect(pages.every((page) => page.trim().length > 0)).toBe(true);
  });

  it("splits a long list only between complete list items", () => {
    const items = Array.from(
      { length: 8 },
      (_, index) => `- item ${index}\n  continuation ${index}\n`,
    );

    const pages = paginateDocumentSource(items.join(""), "MARKDOWN", 75);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => !page.startsWith("  continuation"))).toBe(true);
    expect(pages.join("")).toBe(items.join(""));
  });

  it("does not mistake list-looking code for a new list item", () => {
    const fencedItem = `- example\n  \`\`\`\n- this is code\n${"code\n".repeat(20)}  \`\`\`\n`;
    const source = `${fencedItem}- actual next item\n`;

    const pages = paginateDocumentSource(source, "MARKDOWN", 80);

    expect(pages.filter((page) => page.includes("this is code"))).toEqual([fencedItem]);
  });

  it("splits plain text at line endings", () => {
    const source = "first line\nsecond line\nthird line\n";
    const pages = paginateDocumentSource(source, "TEXT", 20);

    expect(pages).toEqual(["first line\n", "second line\n", "third line\n"]);
    expect(pages.join("")).toBe(source);
  });

  // NIL-484: a document with no natural break point inside a chunk (no blank
  // line, no fence, no heading -- a run-on paragraph, or a TEXT document with
  // no newlines at all) used to become one unpaginated page however large.
  // WebKit's text layout for one unbroken multi-megabyte run blocks the main
  // thread for roughly 1s (measured); every other engine handles the same
  // content in a fraction of that. The fix hard-splits splittable content at
  // the budget instead of leaving it whole.
  it("splits an unbroken plain-text line that has no newline at all", () => {
    const source = "word ".repeat(20_000); // ~100,000 chars, one line, no \n

    const pages = paginateDocumentSource(source, "TEXT", DOCUMENT_PAGE_CHAR_BUDGET);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= DOCUMENT_PAGE_CHAR_BUDGET)).toBe(true);
    expect(pages.join("")).toBe(source);
  });

  it("splits a run-on markdown paragraph with no blank line to break on", () => {
    const source = "word ".repeat(20_000); // one atomic block, far over budget

    const pages = paginateDocumentSource(source, "MARKDOWN", DOCUMENT_PAGE_CHAR_BUDGET);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= DOCUMENT_PAGE_CHAR_BUDGET)).toBe(true);
    expect(pages.join("")).toBe(source);
  });

  it("still keeps an oversized fenced code block on one page (not hard-split)", () => {
    const fence = `\`\`\`text\n${"x".repeat(200)}\n\`\`\`\n`;

    const pages = paginateDocumentSource(fence, "MARKDOWN", 80);

    expect(pages).toEqual([fence]);
  });

  // Every candidate page is blank and dropped by paginateChunks's flush()
  // when the WHOLE source is blank -- the pre-fix fallback then handed back
  // the entire unbounded source as one page. Both TEXT (no batching, one
  // splittable chunk per line) and MARKDOWN (one big batched blank block,
  // now hard-split -- and the hard-split's own trailing-whitespace merge
  // must not walk all the way back down to one piece either) hit this.
  it("bounds an entirely-blank TEXT document instead of falling back to the whole source", () => {
    const source = "\n".repeat(200_000);

    const pages = paginateDocumentSource(source, "TEXT", DOCUMENT_PAGE_CHAR_BUDGET);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= DOCUMENT_PAGE_CHAR_BUDGET)).toBe(true);
  });

  it("bounds an entirely-blank MARKDOWN document instead of falling back to the whole source", () => {
    const source = "\n".repeat(200_000);

    const pages = paginateDocumentSource(source, "MARKDOWN", DOCUMENT_PAGE_CHAR_BUDGET);

    expect(pages.length).toBeGreaterThan(1);
    // The single allowed trailing-whitespace merge can leave the last piece
    // up to ~2x budget; still a world apart from the whole 200,000-char
    // source as one page.
    expect(pages.every((page) => page.length <= DOCUMENT_PAGE_CHAR_BUDGET * 2)).toBe(true);
  });

  // NIL-484's actual reported shape (see e2e/tests/document-pages.spec.ts,
  // PATHOLOGICAL_MARKDOWN): a 2 MiB document that is almost entirely blank
  // lines produced one atomic block PER blank line -- ~2.1 million block
  // objects for this fixture -- which dominated pagination time (1.6s+
  // measured) independent of the hard-split fix above, since no individual
  // blank-line block was ever over budget. Batching a blank run into one
  // block, the same way every other block kind is already batched, fixes it.
  it("bounds pages from a pathological mostly-blank-lines document in linear time", () => {
    const sparseLineBlock = `${"\n".repeat(19_999)}x`;
    const source = sparseLineBlock.repeat(105).slice(0, 2 * 1024 * 1024);
    const started = performance.now();

    const pages = paginateDocumentSource(source, "MARKDOWN", DOCUMENT_PAGE_CHAR_BUDGET);
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(500);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= DOCUMENT_PAGE_CHAR_BUDGET)).toBe(true);
  });

  it("bounds pages from a pathological 500,000-row table in linear time", () => {
    const header = "| Value |\n| --- |\n";
    const source = `${header}${"| cell |\n".repeat(500_000)}`;
    const started = performance.now();

    const pages = paginateDocumentSource(source, "MARKDOWN");
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(5_000);
    expect(pages.length).toBeGreaterThan(200);
    expect(pages.every((page) => page.startsWith(header))).toBe(true);
    expect(pages.every((page) => page.length <= DOCUMENT_PAGE_CHAR_BUDGET)).toBe(true);
  });
});
