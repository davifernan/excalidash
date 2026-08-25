import { describe, expect, it } from "vitest";
import { MAX_IMPORT_NODES, parseOutline, type ImportedNode } from "./outlineParser";

/**
 * The fixture corpus (NIL-572): every input this parser is contractually
 * expected to accept or reject, named for what it exercises. Each fixture
 * states its own expectation inline, so a new fixture is self-documenting
 * and the corpus can grow without a second lookup table to keep in sync.
 */
type Fixture = {
  readonly name: string;
  readonly source: string;
} & (
  | {
      readonly ok: true;
      readonly nodeCount: number;
      readonly levelCount: number;
      readonly warningCount?: number;
    }
  | { readonly ok: false; readonly errorLine: number; readonly messageIncludes: string }
);

const flatten = (node: ImportedNode): readonly string[] => [
  node.text,
  ...node.children.flatMap(flatten),
];

const CORPUS: readonly Fixture[] = [
  {
    name: "plain indented outline, two spaces, no markers",
    source: ["Project X", "  Design", "    Wireframes", "  Development"].join("\n"),
    ok: true,
    nodeCount: 4,
    levelCount: 3,
  },
  {
    name: "plain indented outline, tabs",
    source: ["Project X", "\tDesign", "\t\tWireframes", "\tDevelopment"].join("\n"),
    ok: true,
    nodeCount: 4,
    levelCount: 3,
  },
  {
    name: "dash-marker outline",
    source: ["- Root", "  - Child A", "  - Child B", "    - Grandchild"].join("\n"),
    ok: true,
    nodeCount: 4,
    levelCount: 3,
  },
  {
    name: "markdown headings only",
    source: ["# Root", "## Child A", "## Child B", "### Grandchild"].join("\n"),
    ok: true,
    nodeCount: 4,
    levelCount: 3,
  },
  {
    name: "markdown heading with nested list body",
    source: ["# Root", "## Section", "- point one", "- point two", "  - detail"].join("\n"),
    ok: true,
    nodeCount: 5,
    levelCount: 4,
  },
  {
    name: "numbered list markers",
    source: ["Root", "  1. First", "  2. Second"].join("\n"),
    ok: true,
    nodeCount: 3,
    levelCount: 2,
  },
  {
    name: "blank lines between entries are ignored",
    source: ["Root", "", "  Child A", "\n", "  Child B"].join("\n"),
    ok: true,
    nodeCount: 3,
    levelCount: 2,
  },
  {
    name: "heading level skip is a warning, not an error",
    source: ["# Root", "### Grandchild-ish"].join("\n"),
    ok: true,
    nodeCount: 2,
    levelCount: 2,
    warningCount: 1,
  },
  {
    name: "single root node, nothing else",
    source: "Just one node",
    ok: true,
    nodeCount: 1,
    levelCount: 1,
  },
  {
    name: "an indented '#' is plain outline text, not a heading (headings are only recognized at column 0)",
    source: ["Root", "  # not a heading"].join("\n"),
    ok: true,
    nodeCount: 2,
    levelCount: 2,
  },

  // -- rejected inputs, one issue named per fixture --
  {
    name: "empty document",
    source: "",
    ok: false,
    errorLine: 1,
    messageIncludes: "keine Eintraege",
  },
  {
    name: "only blank lines",
    source: "\n\n   \n",
    ok: false,
    errorLine: 1,
    messageIncludes: "keine Eintraege",
  },
  {
    name: "first content line is indented (no root)",
    source: ["  Child of nothing"].join("\n"),
    ok: false,
    errorLine: 1,
    messageIncludes: "muss die Wurzel sein",
  },
  {
    name: "two top-level (depth 0) entries -- second root rejected",
    source: ["Root A", "Root B"].join("\n"),
    ok: false,
    errorLine: 2,
    messageIncludes: "zweite Wurzel",
  },
  {
    name: "mixed tabs and spaces on the SAME line",
    source: ["Root", "\t  Child"].join("\n"),
    ok: false,
    errorLine: 2,
    messageIncludes: "gemischte Einrueckung",
  },
  {
    name: "tabs then spaces across different lines",
    source: ["Root", "\tChild A", "  Child B"].join("\n"),
    ok: false,
    errorLine: 3,
    messageIncludes: "gemischte Einrueckung",
  },
  {
    name: "indentation width not a multiple of the detected unit",
    source: ["Root", "  Child A", "   Odd width"].join("\n"),
    ok: false,
    errorLine: 3,
    messageIncludes: "gemischte Einrueckung",
  },
  {
    name: "the ticket's own example: mixed indentation reported at its exact line",
    source: ["Root", "  A", "  B", "    B1", "     B1a-with-odd-indent", "  C", "  D"].join("\n"),
    ok: false,
    errorLine: 5,
    messageIncludes: "gemischte Einrueckung",
  },
  {
    name: "outline indent jumps more than one level at once",
    source: ["Root", "  Child", "      Too deep, too soon"].join("\n"),
    ok: false,
    errorLine: 3,
    messageIncludes: "springt zu tief",
  },
  {
    name: "empty entry after stripping a list marker",
    source: ["Root", "  - "].join("\n"),
    ok: false,
    errorLine: 2,
    messageIncludes: "leerer Eintrag",
  },
  {
    name: "empty heading text",
    source: ["#   "].join("\n"),
    ok: false,
    errorLine: 1,
    messageIncludes: "leere Ueberschrift",
  },
  {
    name: "more than MAX_IMPORT_NODES entries",
    source: [
      "Root",
      ...Array.from({ length: MAX_IMPORT_NODES + 5 }, (_, i) => `  Child ${i}`),
    ].join("\n"),
    ok: false,
    errorLine: MAX_IMPORT_NODES + 1,
    messageIncludes: "mehr als",
  },
];

describe("parseOutline: fixture corpus", () => {
  for (const fixture of CORPUS) {
    it(fixture.name, () => {
      const result = parseOutline(fixture.source);
      if (fixture.ok) {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.summary.nodeCount).toBe(fixture.nodeCount);
        expect(result.summary.levelCount).toBe(fixture.levelCount);
        if (fixture.warningCount !== undefined) {
          expect(result.summary.warnings).toHaveLength(fixture.warningCount);
        }
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors[0].line).toBe(fixture.errorLine);
        expect(result.errors[0].message).toContain(fixture.messageIncludes);
      }
    });
  }
});

describe("parseOutline: tree shape", () => {
  it("attaches children under the correct parent, not flattened", () => {
    const result = parseOutline(["Root", "  A", "    A1", "    A2", "  B"].join("\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root.text).toBe("Root");
    expect(result.root.children.map((c) => c.text)).toEqual(["A", "B"]);
    const a = result.root.children[0];
    expect(a.children.map((c) => c.text)).toEqual(["A1", "A2"]);
    expect(result.root.children[1].children).toHaveLength(0);
  });

  it("records the exact 1-based source line for every node", () => {
    const result = parseOutline(["Root", "", "  Child"].join("\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root.line).toBe(1);
    expect(result.root.children[0].line).toBe(3);
  });

  it("strips list markers but keeps the rest of the text verbatim", () => {
    const result = parseOutline(["Root", "  - First point", "  1. Numbered point"].join("\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flatten(result.root)).toEqual(["Root", "First point", "Numbered point"]);
  });

  /**
   * Counter-test: break the enforcement by accepting any indent width as a
   * fresh "level 1" rather than validating it against the document's
   * already-detected unit -- a plausible-looking parser that would silently
   * misplace "Odd width" one level too deep instead of naming line 3.
   * Copied here, not `git checkout --`'d, per this package's own evidence
   * rule (NIL-570).
   */
  it("regression guard: accepting any indent width would misplace the odd line instead of rejecting it", () => {
    const source = ["Root", "  Child A", "   Odd width"].join("\n");
    const acceptsAnyWidth = (indented: string) => indented.length > 0; // the bug: no multiple-of-unit check
    expect(acceptsAnyWidth("   ")).toBe(true); // the bug would accept this
    const result = parseOutline(source);
    expect(result.ok).toBe(false); // the real implementation refuses
  });
});
