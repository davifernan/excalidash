export type MarkdownFormatAction = "bold" | "italic" | "heading" | "list" | "link" | "code";

export type MarkdownFormatResult = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

const wrap = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
  before: string,
  after: string,
  placeholder: string,
): MarkdownFormatResult => {
  const selected = value.slice(selectionStart, selectionEnd) || placeholder;
  const inserted = `${before}${selected}${after}`;
  return {
    value: `${value.slice(0, selectionStart)}${inserted}${value.slice(selectionEnd)}`,
    selectionStart: selectionStart + before.length,
    selectionEnd: selectionStart + before.length + selected.length,
  };
};

const prefixLines = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
  prefix: string,
  removePattern: RegExp,
): MarkdownFormatResult => {
  const blockStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const nextLine = value.indexOf("\n", selectionEnd);
  const blockEnd = nextLine === -1 ? value.length : nextLine;
  const lines = value.slice(blockStart, blockEnd).split("\n");
  const formatted = lines
    .map((line) =>
      removePattern.test(line) ? line.replace(removePattern, "") : `${prefix}${line}`,
    )
    .join("\n");
  const delta = formatted.length - (blockEnd - blockStart);
  const firstLinePrefix = lines[0].match(removePattern)?.[0];
  return {
    value: `${value.slice(0, blockStart)}${formatted}${value.slice(blockEnd)}`,
    selectionStart: firstLinePrefix
      ? Math.max(blockStart, selectionStart - firstLinePrefix.length)
      : selectionStart + prefix.length,
    selectionEnd: Math.max(blockStart, selectionEnd + delta),
  };
};

export const applyMarkdownFormat = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
  action: MarkdownFormatAction,
): MarkdownFormatResult => {
  switch (action) {
    case "bold":
      return wrap(value, selectionStart, selectionEnd, "**", "**", "bold text");
    case "italic":
      return wrap(value, selectionStart, selectionEnd, "_", "_", "italic text");
    case "code":
      return wrap(value, selectionStart, selectionEnd, "`", "`", "code");
    case "heading":
      return prefixLines(value, selectionStart, selectionEnd, "## ", /^#{1,6}\s+/);
    case "list":
      return prefixLines(value, selectionStart, selectionEnd, "- ", /^\s*[-*+]\s+/);
    case "link": {
      const selected = value.slice(selectionStart, selectionEnd);
      const label = selected || "link text";
      const inserted = `[${label}](https://)`;
      const urlStart = selectionStart + label.length + 3;
      return {
        value: `${value.slice(0, selectionStart)}${inserted}${value.slice(selectionEnd)}`,
        selectionStart: selected ? urlStart : selectionStart + 1,
        selectionEnd: selected ? urlStart + 8 : selectionStart + 1 + label.length,
      };
    }
  }
};
