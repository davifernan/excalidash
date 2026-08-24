export const DOCUMENT_PAGE_CHAR_BUDGET = 20_000;

/**
 * `splittable: false` marks content whose syntax breaks if cut mid-way -- a
 * fenced code block, a list item, a table row. `splittable: true` is plain
 * prose: cutting it at a character boundary loses nothing but a line wrap.
 *
 * The distinction matters because a chunk over budget with no internal break
 * point (no blank line, no fence, no heading -- one continuous paragraph, or
 * a `TEXT` document with no newlines at all) used to become one page holding
 * the whole thing, unbounded by `budget`. A 2 MiB page like that renders on
 * the main thread with no engine-independent cost: WebKit's text layout for
 * one unbroken run is roughly 5-9x slower there than Chromium's for the same
 * content (NIL-484, measured), which is what "WebKit blocks" actually was --
 * not the pagination step itself, already off-thread since NIL-484's first
 * pass, but the page it handed back never having been paginated at all.
 */
type MarkdownBlock =
  | { kind: "atomic"; content: string; splittable: boolean }
  | { kind: "heading"; content: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; header: string; separator: string; rows: string[] };

type Chunk = { content: string; splittable: boolean };

const withoutLineEnding = (line: string) => line.replace(/[\r\n]+$/, "");
const isBlank = (line: string) => withoutLineEnding(line).trim().length === 0;
const headingPattern = /^ {0,3}#{1,6}(?:\s|$)/;
const listItemPattern = /^( {0,3})(?:[-+*]|\d{1,9}[.)])\s+/;

const splitLines = (source: string) => {
  if (source.length === 0) return [""];
  return source.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? [source];
};

const fenceOpening = (line: string) => {
  const match = withoutLineEnding(line).match(/^ {0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  return { marker: match[1][0], length: match[1].length };
};

const isFenceClosing = (line: string, opening: { marker: string; length: number }) => {
  const match = withoutLineEnding(line).match(/^ {0,3}(`{3,}|~{3,})\s*$/);
  return Boolean(match && match[1][0] === opening.marker && match[1].length >= opening.length);
};

const isTableSeparator = (line: string) => {
  const value = withoutLineEnding(line).trim();
  if (!value.includes("|")) return false;
  const cells = value.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
};

const startsTable = (lines: string[], index: number) =>
  index + 1 < lines.length &&
  withoutLineEnding(lines[index]).includes("|") &&
  isTableSeparator(lines[index + 1]);

const isTableRow = (line: string) => {
  const value = withoutLineEnding(line);
  return value.trim().length > 0 && value.includes("|");
};

const readFence = (lines: string[], start: number, opening: { marker: string; length: number }) => {
  let end = start + 1;
  while (end < lines.length) {
    const closesFence = isFenceClosing(lines[end], opening);
    end += 1;
    if (closesFence) break;
  }
  return end;
};

const readTable = (lines: string[], start: number) => {
  let end = start + 2;
  while (end < lines.length && isTableRow(lines[end])) end += 1;
  return {
    block: {
      kind: "table" as const,
      header: lines[start],
      separator: lines[start + 1],
      rows: lines.slice(start + 2, end),
    },
    end,
  };
};

const indentation = (line: string) => withoutLineEnding(line).match(/^ */)?.[0].length ?? 0;

const readList = (lines: string[], start: number) => {
  const baseIndent = listItemPattern.exec(withoutLineEnding(lines[start]))?.[1].length ?? 0;
  const items: string[] = [];
  let item = lines[start];
  let index = start + 1;
  let openFence: { marker: string; length: number } | null = null;

  while (index < lines.length) {
    const line = lines[index];
    if (openFence) {
      item += line;
      if (isFenceClosing(line, openFence)) openFence = null;
      index += 1;
      continue;
    }
    const opening = fenceOpening(line);
    if (opening) {
      item += line;
      openFence = opening;
      index += 1;
      continue;
    }
    const marker = listItemPattern.exec(withoutLineEnding(line));
    if (marker?.[1].length === baseIndent) {
      items.push(item);
      item = line;
      index += 1;
      continue;
    }
    if (!isBlank(line)) {
      item += line;
      index += 1;
      continue;
    }

    let next = index;
    let blankLines = "";
    while (next < lines.length && isBlank(lines[next])) {
      blankLines += lines[next];
      next += 1;
    }
    const nextMarker =
      next < lines.length ? listItemPattern.exec(withoutLineEnding(lines[next])) : null;
    const listContinues =
      next < lines.length &&
      (nextMarker?.[1].length === baseIndent || indentation(lines[next]) > baseIndent);
    item += blankLines;
    if (!listContinues) {
      index = next;
      break;
    }
    index = next;
  }

  items.push(item);
  return { block: { kind: "list" as const, items }, end: index };
};

const markdownBlocks = (source: string): MarkdownBlock[] => {
  const lines = splitLines(source);
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    if (headingPattern.test(withoutLineEnding(lines[index]))) {
      blocks.push({ kind: "heading", content: lines[index] });
      index += 1;
      continue;
    }
    const opening = fenceOpening(lines[index]);
    if (opening) {
      const end = readFence(lines, index, opening);
      blocks.push({
        kind: "atomic",
        content: lines.slice(index, end).join(""),
        splittable: false,
      });
      index = end;
      continue;
    }
    if (startsTable(lines, index)) {
      const table = readTable(lines, index);
      blocks.push(table.block);
      index = table.end;
      continue;
    }
    if (listItemPattern.test(withoutLineEnding(lines[index]))) {
      const list = readList(lines, index);
      blocks.push(list.block);
      index = list.end;
      continue;
    }

    const start = index;
    index += 1;
    if (isBlank(lines[start])) {
      // A run of blank lines used to become one atomic block per line -- a
      // pathological document that is mostly blank lines (NIL-484: a 2 MiB
      // markdown source with ~2.1 million one-character lines) turned this
      // into millions of block objects and dominated pagination time (1.6s+
      // measured) well before the render this file's other NIL-484 fix
      // addresses ever happens. Consuming the whole run here is the same
      // batching every other block kind already gets.
      while (index < lines.length && isBlank(lines[index])) {
        index += 1;
      }
    } else if (!headingPattern.test(withoutLineEnding(lines[start]))) {
      while (
        index < lines.length &&
        !isBlank(lines[index]) &&
        !headingPattern.test(withoutLineEnding(lines[index])) &&
        !fenceOpening(lines[index]) &&
        !startsTable(lines, index) &&
        !listItemPattern.test(withoutLineEnding(lines[index]))
      ) {
        index += 1;
      }
    }
    blocks.push({ kind: "atomic", content: lines.slice(start, index).join(""), splittable: true });
  }

  return blocks;
};

const splitParts = (prefix: string, parts: string[], budget: number) => {
  if (parts.length === 0) return [prefix];
  const chunks: string[] = [];
  let chunk = prefix;
  let partCount = 0;

  for (const part of parts) {
    if (partCount > 0 && chunk.length + part.length > budget) {
      chunks.push(chunk);
      chunk = prefix;
      partCount = 0;
    }
    if (partCount === 0 && chunk.length + part.length > budget) {
      chunks.push(chunk + part);
      chunk = prefix;
      continue;
    }
    chunk += part;
    partCount += 1;
  }
  if (partCount > 0) chunks.push(chunk);
  return chunks;
};

/**
 * A chunk over budget with nothing to split on used to become one page,
 * however large -- see the comment on `MarkdownBlock` above. `splittable`
 * chunks are hard-cut at `budget` instead: `splittable: false` chunks (a
 * fence, a list item, a table row) keep the old whole-page behavior, because
 * a character cut through their syntax would corrupt it.
 */
const paginateChunks = (chunks: Chunk[], budget: number) => {
  const pages: string[] = [];
  let page = "";
  const flush = () => {
    if (page.trim().length > 0) pages.push(page);
    page = "";
  };

  for (const chunk of chunks) {
    if (page.length > 0 && page.length + chunk.content.length > budget) {
      flush();
    }
    if (chunk.content.length > budget) {
      if (page.length > 0) flush();
      if (chunk.splittable) {
        const pieces: string[] = [];
        for (let i = 0; i < chunk.content.length; i += budget) {
          pieces.push(chunk.content.slice(i, i + budget));
        }
        // A trailing piece can be pure trailing whitespace (a line ending
        // that landed exactly on a budget boundary) -- fold it back into the
        // piece before it instead of pushing it as its own near-blank page.
        // At most once: every piece but the last is exactly `budget` long by
        // construction, so a second merge only happens when the WHOLE chunk
        // is blank -- and a `while` here used to keep merging until one
        // piece remained, recreating the unbounded page this hard-split
        // exists to prevent (an all-blank document hit exactly this).
        if (pieces.length > 1 && isBlank(pieces[pieces.length - 1])) {
          const last = pieces.pop() as string;
          pieces[pieces.length - 1] += last;
        }
        pages.push(...pieces);
      } else {
        pages.push(chunk.content);
      }
      page = "";
      continue;
    }
    page += chunk.content;
  }
  if (page.length > 0) flush();
  return pages;
};

const paginateMarkdown = (source: string, budget: number) => {
  const chunks: Chunk[] = [];
  let heading = "";
  for (const block of markdownBlocks(source)) {
    if (block.kind === "heading") {
      heading += block.content;
      continue;
    }
    if (heading && block.kind === "atomic" && block.content.trim().length === 0) {
      heading += block.content;
      continue;
    }
    const blockChunks: Chunk[] =
      block.kind === "atomic"
        ? [{ content: block.content, splittable: block.splittable }]
        : block.kind === "list"
          ? splitParts("", block.items, budget).map((content) => ({
              content,
              splittable: false,
            }))
          : splitParts(block.header + block.separator, block.rows, budget).map((content) => ({
              content,
              splittable: false,
            }));
    if (heading) {
      blockChunks[0] = { ...blockChunks[0], content: heading + blockChunks[0].content };
      heading = "";
    }
    chunks.push(...blockChunks);
  }
  if (heading) chunks.push({ content: heading, splittable: false });
  return paginateChunks(chunks, budget);
};

const paginatePlainText = (source: string, budget: number) =>
  paginateChunks(
    splitLines(source).map((content) => ({ content, splittable: true })),
    budget,
  );

export const paginateDocumentSource = (
  source: string,
  kind: "MARKDOWN" | "TEXT",
  budget = DOCUMENT_PAGE_CHAR_BUDGET,
) => {
  if (source.length === 0) return [""];
  if (!Number.isFinite(budget) || budget < 1) throw new Error("Page budget must be positive.");
  const pages =
    kind === "MARKDOWN" ? paginateMarkdown(source, budget) : paginatePlainText(source, budget);
  if (pages.length > 0) return pages;

  // Every candidate page was blank and dropped -- flush() in paginateChunks
  // never pushes a whitespace-only page -- which only happens when the whole
  // source is blank. A document like that still has to render as *something*
  // bounded by budget, not fall back to the entire unbounded source: an
  // all-newline 2 MiB TEXT document hit exactly this before the fix (NIL-484),
  // handing the widget one page of ~2 million blank lines to lay out.
  const hardSplit: string[] = [];
  for (let i = 0; i < source.length; i += budget) hardSplit.push(source.slice(i, i + budget));
  return hardSplit;
};
