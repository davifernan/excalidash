/**
 * Server copy of the deterministic text-document pagination contract.
 * Keep this algorithm byte-for-byte equivalent to the frontend implementation;
 * shared fixtures in both packages guard the boundary.
 */
export const DOCUMENT_PAGE_CHAR_BUDGET = 20_000;

type MarkdownBlock =
  | { kind: "atomic"; content: string }
  | { kind: "heading"; content: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; header: string; separator: string; rows: string[] };

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
      blocks.push({ kind: "atomic", content: lines.slice(index, end).join("") });
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
    if (!isBlank(lines[start]) && !headingPattern.test(withoutLineEnding(lines[start]))) {
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
    blocks.push({ kind: "atomic", content: lines.slice(start, index).join("") });
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

const paginateChunks = (chunks: string[], budget: number) => {
  const pages: string[] = [];
  let page = "";
  const flush = () => {
    if (page.trim().length > 0) pages.push(page);
    page = "";
  };

  for (const chunk of chunks) {
    if (page.length > 0 && page.length + chunk.length > budget) flush();
    if (chunk.length > budget) {
      if (page.length > 0) flush();
      pages.push(chunk);
      page = "";
      continue;
    }
    page += chunk;
  }
  if (page.length > 0) flush();
  return pages;
};

const paginateMarkdown = (source: string, budget: number) => {
  const chunks: string[] = [];
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
    const blockChunks =
      block.kind === "atomic"
        ? [block.content]
        : block.kind === "list"
          ? splitParts("", block.items, budget)
          : splitParts(block.header + block.separator, block.rows, budget);
    if (heading) {
      blockChunks[0] = heading + blockChunks[0];
      heading = "";
    }
    chunks.push(...blockChunks);
  }
  if (heading) chunks.push(heading);
  return paginateChunks(chunks, budget);
};

const paginatePlainText = (source: string, budget: number) =>
  paginateChunks(splitLines(source), budget);

export const paginateDocumentSource = (
  source: string,
  kind: "MARKDOWN" | "TEXT",
  budget = DOCUMENT_PAGE_CHAR_BUDGET,
) => {
  if (source.length === 0) return [""];
  if (!Number.isFinite(budget) || budget < 1) throw new Error("Page budget must be positive.");
  const pages =
    kind === "MARKDOWN" ? paginateMarkdown(source, budget) : paginatePlainText(source, budget);
  return pages.length > 0 ? pages : [source];
};
