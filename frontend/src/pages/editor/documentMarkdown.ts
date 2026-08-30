import type { Element, Nodes, Parents, Root } from "hast";
import { urlAttributes } from "html-url-attributes";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i;

/** Keep the URL policy byte-for-byte equivalent to react-markdown's default. */
export const safeMarkdownUrl = (value: string): string => {
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");

  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    safeProtocol.test(value.slice(0, colon))
  ) {
    return value;
  }

  return "";
};

const prepareNode = (node: Nodes, parent?: Parents, index?: number): void => {
  // Source offsets can dominate the structured clone for ordinary documents,
  // while the renderer neither exposes nor consumes them.
  delete node.position;

  if (node.type === "raw" && parent && index !== undefined) {
    parent.children[index] = { type: "text", value: node.value };
    return;
  }

  if (node.type === "element") {
    const element = node as Element;
    for (const key in urlAttributes) {
      if (
        Object.hasOwn(urlAttributes, key) &&
        Object.hasOwn(element.properties, key) &&
        (urlAttributes[key] === null || urlAttributes[key]?.includes(element.tagName))
      ) {
        element.properties[key] = safeMarkdownUrl(String(element.properties[key] || ""));
      }
    }
  }

  if ("children" in node) {
    node.children.forEach((child, childIndex) => prepareNode(child, node, childIndex));
  }
};

/**
 * Parse and sanitize one visible Markdown page into a structured-cloneable HAST.
 *
 * This intentionally mirrors the react-markdown pipeline that used to execute
 * synchronously during React render. Keeping it as a pure function gives the
 * worker and the unit tests one contract instead of two subtly different ones.
 */
export const prepareMarkdownForRender = (source: string): Root => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true });
  const tree = processor.runSync(processor.parse(source)) as Root;
  prepareNode(tree);
  return tree;
};
