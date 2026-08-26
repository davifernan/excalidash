import { describe, expect, it } from "vitest";
import { paginateDocumentSource as paginateOnServer } from "./documentPagination";
import { paginateDocumentSource as paginateInBrowser } from "../../../frontend/src/pages/editor/documentPagination";

const fixtures = [
  { name: "empty text", kind: "TEXT" as const, source: "", budget: 20 },
  {
    name: "plain lines across a boundary",
    kind: "TEXT" as const,
    source: "one\ntwo\nthree\nfour\n",
    budget: 9,
  },
  {
    name: "markdown list",
    kind: "MARKDOWN" as const,
    source: "# Tasks\n\n- first item\n- second item\n- third item\n",
    budget: 24,
  },
  {
    name: "markdown table",
    kind: "MARKDOWN" as const,
    source: "| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |\n| gamma | 3 |\n",
    budget: 42,
  },
  {
    name: "fenced block kept atomic",
    kind: "MARKDOWN" as const,
    source: "Before\n\n```ts\nconst value = 1;\nconst next = 2;\n```\n\nAfter\n",
    budget: 20,
  },
];

const productionDefaultFixture = {
  kind: "TEXT" as const,
  source: `${"a".repeat(10_000)}\n${"b".repeat(9_998)}\n`,
};

describe("document pagination package contract", () => {
  it.each(fixtures)("keeps server and browser equal for $name", ({ kind, source, budget }) => {
    expect(paginateOnServer(source, kind, budget)).toEqual(paginateInBrowser(source, kind, budget));
  });

  it("keeps server and browser equal at the production default budget", () => {
    const { kind, source } = productionDefaultFixture;
    const serverPages = paginateOnServer(source, kind);
    const browserPages = paginateInBrowser(source, kind);

    expect(serverPages.length, "server and browser default-budget page counts").toBe(
      browserPages.length,
    );
    expect(serverPages).toEqual(browserPages);
  });

  it("splits 50,000 characters without a separator into the same three pages", () => {
    const source = "x".repeat(50_000);
    const serverPages = paginateOnServer(source, "TEXT");
    const browserPages = paginateInBrowser(source, "TEXT");

    expect(serverPages).toHaveLength(3);
    expect(browserPages).toEqual(serverPages);
  });
});
