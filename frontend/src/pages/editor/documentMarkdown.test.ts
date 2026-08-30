import type { Nodes } from "hast";
import { describe, expect, it } from "vitest";
import { prepareMarkdownForRender, safeMarkdownUrl } from "./documentMarkdown";

const flatten = (node: Nodes): Nodes[] => [
  node,
  ...("children" in node ? node.children.flatMap(flatten) : []),
];

describe("Markdown preparation", () => {
  it("prepares GFM without retaining source offsets or executable raw HTML", () => {
    const tree = prepareMarkdownForRender(
      [
        "# Notes",
        "",
        '<script>window.secret = "LEAKME"</script>',
        "",
        "| A | B |",
        "| - | - |",
        "| one | two |",
      ].join("\n"),
    );
    const nodes = flatten(tree);

    expect(nodes.every((node) => node.position === undefined)).toBe(true);
    expect(nodes.some((node) => node.type === "raw")).toBe(false);
    expect(nodes).toContainEqual({
      type: "text",
      value: '<script>window.secret = "LEAKME"</script>',
    });
    expect(nodes.some((node) => node.type === "element" && node.tagName === "table")).toBe(true);
  });

  it("keeps react-markdown's URL boundary before the tree crosses the worker boundary", () => {
    expect(safeMarkdownUrl("https://example.com/path")).toBe("https://example.com/path");
    expect(safeMarkdownUrl("mailto:person@example.com")).toBe("mailto:person@example.com");
    expect(safeMarkdownUrl("/relative/path")).toBe("/relative/path");
    expect(safeMarkdownUrl("javascript:alert(1)")).toBe("");

    const tree = prepareMarkdownForRender("[bad](javascript:alert(1)) [web](https://example.com)");
    const links = flatten(tree).filter((node) => node.type === "element" && node.tagName === "a");
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ properties: { href: "" } });
    expect(links[1]).toMatchObject({ properties: { href: "https://example.com" } });
  });
});
