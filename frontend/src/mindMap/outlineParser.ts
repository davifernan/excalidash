/**
 * Text -> tree, once (NIL-572, Mind Map v3, first delivery slice).
 *
 * Parses a limited Markdown subset (ATX headings `#`..`######`, nested
 * lists `-`/`*`/`1.`) or a plain indented outline (no markers, indentation
 * alone) into the same tree shape `model.ts`'s `NormalizedMindMap` already
 * uses -- this is a ONE-TIME import into the living relationship layer, not
 * a second mind-map representation and not an ongoing sync to the source
 * text. There is no attempt to preserve the source formatting on a
 * roundtrip; only the tree structure and each line's text matter.
 *
 * The ticket explicitly rejects `mermaid-to-excalidraw` for this: the
 * pinned dependency does not parse Mermaid's own `mindmap` syntax at all,
 * and even a successful parse would only produce ordinary elements with no
 * durable tree semantics (`customData.excalidash.mindMap`) -- exactly the
 * relationship layer this whole package exists to keep authoritative. This
 * parser is deliberately small and owns its own grammar instead.
 *
 * Pure, DOM-free, no Excalidraw/adapter knowledge whatsoever -- same
 * purity discipline as `layout.ts`/`model.ts`. `mindMapImport.ts` is the
 * only file allowed to turn a successful `ParseResult` into `SceneOp`s.
 *
 * ## Errors are positional, not generic
 *
 * The product contract (this ticket) requires "Zeile 7: gemischte
 * Einrueckung", not "Import fehlgeschlagen" -- every `ImportIssue` names
 * the exact source line and states the specific problem, never a bare
 * failure.
 *
 * ## Headings vs. list/outline indentation: different tolerance, on purpose
 *
 * A heading level that skips (`#` straight to `###`) is common and rarely
 * a mistake in real Markdown, so it is a WARNING: the skipped level is
 * silently absorbed (the `###` becomes a direct child of the `#`) and
 * import still proceeds. An indentation width that is not a clean multiple
 * of the document's own detected indent unit is much more likely a
 * fat-fingered extra space or a stray tab, so for list/outline lines the
 * same shape of problem is a hard ERROR instead: it is safer to name the
 * problem line and ask than to silently guess the intended depth of an
 * outline that was never meant to skip.
 */

export type ImportedNode = {
  readonly text: string;
  /** 1-based source line this node came from. */
  readonly line: number;
  readonly children: readonly ImportedNode[];
};

export type ImportIssue = {
  /** 1-based source line the issue is about. */
  readonly line: number;
  readonly message: string;
};

export type ImportSummary = {
  readonly rootText: string;
  readonly nodeCount: number;
  /** Root counts as level 1. */
  readonly levelCount: number;
  readonly warnings: readonly ImportIssue[];
};

export type ParseResult =
  | { readonly ok: true; readonly root: ImportedNode; readonly summary: ImportSummary }
  | { readonly ok: false; readonly errors: readonly ImportIssue[] };

/** A pasted outline larger than this is almost certainly a mistake (wrong clipboard, wrong file) rather than a real mind map. */
export const MAX_IMPORT_NODES = 500;

const HEADING = /^(#{1,6})\s+(\S.*)$/;
const LIST_MARKER = /^(?:[-*]|\d+\.)\s+/;

type Kind = "heading" | "line";

type Classified = {
  readonly kind: Kind;
  readonly line: number;
  readonly indent: string;
  readonly headingLevel: number; // only meaningful for kind === "heading"
  readonly text: string;
};

const err = (line: number, message: string): ImportIssue => ({ line, message });

/** Indent width in columns: a tab counts as one column, same as a single space -- this parser only compares indents to each other within one document, never to a fixed tab-stop width. */
const indentWidth = (indent: string): number => indent.length;

const EMPTY_HEADING = /^(#{1,6})\s*$/;

const classify = (rawLine: string, lineNumber: number): Classified | null => {
  if (rawLine.trim().length === 0) return null; // blank line: ignored, does not affect depth

  const headingMatch = HEADING.exec(rawLine.trimEnd());
  if (headingMatch) {
    return {
      kind: "heading",
      line: lineNumber,
      indent: "",
      headingLevel: headingMatch[1].length,
      text: headingMatch[2].trim(),
    };
  }
  const emptyHeadingMatch = EMPTY_HEADING.exec(rawLine.trim());
  if (emptyHeadingMatch) {
    return {
      kind: "heading",
      line: lineNumber,
      indent: "",
      headingLevel: emptyHeadingMatch[1].length,
      text: "",
    };
  }

  const indentMatch = /^[ \t]*/.exec(rawLine);
  const indent = indentMatch ? indentMatch[0] : "";
  const rest = rawLine.slice(indent.length).replace(LIST_MARKER, "");
  return { kind: "line", line: lineNumber, indent, headingLevel: 0, text: rest.trim() };
};

/**
 * Parse `source` into one tree.
 *
 * Every non-blank line is classified independently; the first content line
 * MUST land at depth 0 (there is exactly one root, same invariant
 * `model.ts`'s `normalizeMindMap` already enforces on the live scene) --
 * failing that closed rather than guessing which line the user meant as
 * the root.
 */
export function parseOutline(source: string): ParseResult {
  const lines = source.split(/\r\n|\r|\n/);
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];

  let indentUnit: number | null = null;
  let sawHeading = false;
  let lastHeadingDepth = -1; // -1 == no heading seen yet
  let sawTabIndent: boolean | null = null; // true = tabs, false = spaces, once fixed for the whole doc

  const stack: ImportedNode[] = [];
  let root: ImportedNode | null = null;
  let nodeCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const classified = classify(lines[i], i + 1);
    if (!classified) continue;

    if (classified.kind === "line" && classified.text.length === 0) {
      errors.push(err(classified.line, "leerer Eintrag"));
      continue;
    }
    if (classified.kind === "heading" && classified.text.length === 0) {
      errors.push(err(classified.line, "leere Ueberschrift"));
      continue;
    }

    let depth: number;

    if (classified.kind === "heading") {
      sawHeading = true;
      const wanted = classified.headingLevel - 1;
      const maxAllowed = stack.length; // one deeper than whatever is currently open
      if (wanted > maxAllowed) {
        warnings.push(
          err(
            classified.line,
            `Ebene uebersprungen (Ueberschrift ${"#".repeat(classified.headingLevel)} direkt unter Ebene ${maxAllowed})`,
          ),
        );
      }
      depth = Math.min(wanted, maxAllowed);
      lastHeadingDepth = depth;
    } else {
      if (classified.indent.length > 0) {
        const hasTab = classified.indent.includes("\t");
        const hasSpace = classified.indent.includes(" ");
        if (hasTab && hasSpace) {
          errors.push(err(classified.line, "gemischte Einrueckung (Tabs und Leerzeichen)"));
          continue;
        }
        if (sawTabIndent === null) sawTabIndent = hasTab;
        else if (sawTabIndent !== hasTab) {
          errors.push(
            err(
              classified.line,
              `gemischte Einrueckung (Rest des Dokuments verwendet ${sawTabIndent ? "Tabs" : "Leerzeichen"})`,
            ),
          );
          continue;
        }
      }

      const width = indentWidth(classified.indent);
      let listDepth = 0;
      if (width > 0) {
        if (indentUnit === null) {
          indentUnit = width;
          listDepth = 1;
        } else if (width % indentUnit === 0) {
          listDepth = width / indentUnit;
        } else {
          errors.push(
            err(
              classified.line,
              `gemischte Einrueckung (${width} Spalten passt nicht zur erkannten Einrueckungsbreite von ${indentUnit})`,
            ),
          );
          continue;
        }
      }

      const base = sawHeading ? lastHeadingDepth + 1 : 0;
      depth = base + listDepth;

      const maxAllowed = stack.length;
      if (depth > maxAllowed && maxAllowed > 0) {
        errors.push(
          err(
            classified.line,
            `Einrueckung springt zu tief (Ebene ${depth + 1} ohne Ebene ${maxAllowed + 1})`,
          ),
        );
        continue;
      }
    }

    if (depth === 0) {
      if (root) {
        errors.push(
          err(
            classified.line,
            "zweite Wurzel auf Ebene 1 nicht erlaubt (ein Mind Map hat genau eine Wurzel)",
          ),
        );
        continue;
      }
    } else if (stack.length === 0) {
      errors.push(
        err(
          classified.line,
          "erste Zeile muss die Wurzel sein (Ebene 1, keine Einrueckung, kein '#')",
        ),
      );
      continue;
    }

    const node: ImportedNode = { text: classified.text, line: classified.line, children: [] };
    stack.length = depth;
    if (depth === 0) {
      root = node;
    } else {
      const parent = stack[depth - 1];
      (parent.children as ImportedNode[]).push(node);
    }
    stack.push(node);
    nodeCount += 1;

    if (nodeCount > MAX_IMPORT_NODES) {
      errors.push(
        err(
          classified.line,
          `mehr als ${MAX_IMPORT_NODES} Eintraege -- das ist vermutlich nicht die richtige Datei`,
        ),
      );
      break;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  if (!root) return { ok: false, errors: [err(1, "keine Eintraege gefunden")] };

  const levelCount = maxDepth(root) + 1;
  return {
    ok: true,
    root,
    summary: { rootText: root.text, nodeCount, levelCount, warnings },
  };
}

const maxDepth = (node: ImportedNode): number =>
  node.children.length === 0 ? 0 : 1 + Math.max(...node.children.map(maxDepth));
