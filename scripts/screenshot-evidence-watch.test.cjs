"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyScreenshotEvidence,
  imageUrls,
  inspectPr,
  primaryPackage,
  runWatch,
} = require("./screenshot-evidence-watch.cjs");

const SHA = "a".repeat(40);

const issue = (overrides = {}) => ({
  identifier: "NIL-621",
  labels: [{ name: "screenshot needed" }],
  ...overrides,
});

const pr = (overrides = {}) => ({
  number: 192,
  isDraft: false,
  headRefOid: SHA,
  url: "https://github.com/davifernan/excalidash/pull/192",
  labels: [],
  body: "Multica-Package: NIL-621",
  ...overrides,
});

test("extracts exactly one canonical package and rejects an ambiguous contract", () => {
  assert.equal(primaryPackage("Multica-Package: NIL-621"), "NIL-621");
  assert.equal(primaryPackage("Multica-Package: NIL-621\nMultica-Package: NIL-622"), null);
  assert.equal(primaryPackage("no package"), null);
});

test("recognizes Markdown and HTML images without treating ordinary links as evidence", () => {
  assert.deepEqual(
    imageUrls(
      [
        "[not an image](https://example.test/a.png)",
        "![proof](https://example.test/proof.png)",
        '<img alt="proof" src="https://example.test/proof.webp">',
      ].join("\n"),
    ),
    ["https://example.test/proof.png", "https://example.test/proof.webp"],
  );
});

test("recognizes full and collapsed Markdown image references", () => {
  assert.deepEqual(
    imageUrls(
      [
        "![light theme][Light Proof]",
        "![dark-proof][]",
        '[light proof]: https://example.test/light.png "Light"',
        "[dark-proof]: <https://example.test/dark.webp>",
      ].join("\n"),
    ),
    ["https://example.test/light.png", "https://example.test/dark.webp"],
  );
});

test("requires the explicit ticket label instead of inferring screenshots from frontend", () => {
  assert.deepEqual(
    classifyScreenshotEvidence({ issue: issue({ labels: [{ name: "frontend" }] }), pr: pr() }),
    { result: "not-required", reason: "ticket-label-absent" },
  );
});

test("does not fail a draft that still has time to attach its evidence", () => {
  assert.deepEqual(classifyScreenshotEvidence({ issue: issue(), pr: pr({ isDraft: true }) }), {
    result: "pending",
    reason: "draft",
  });
});

test("accepts only durable raw image links from the permanent evidence branch", () => {
  const url = "https://raw.githubusercontent.com/davifernan/excalidash/evidence/nil-621/light.png";
  assert.deepEqual(
    classifyScreenshotEvidence({
      issue: issue(),
      pr: pr(),
      comments: [{ body: `![light](${url})` }],
    }),
    { result: "satisfied", supportedUrls: [url] },
  );
});

test("a confident absence is missing, but an unfamiliar image host is ambiguous", () => {
  assert.deepEqual(classifyScreenshotEvidence({ issue: issue(), pr: pr(), comments: [] }), {
    result: "missing",
    reason: "no-image-reference",
  });
  assert.deepEqual(
    classifyScreenshotEvidence({
      issue: issue(),
      pr: pr(),
      comments: [{ body: "![possible proof](https://uploads.example.test/proof.png)" }],
    }),
    {
      result: "ambiguous",
      reason: "unrecognized-image-location",
      urls: ["https://uploads.example.test/proof.png"],
    },
  );
});

const adapterFor = ({ issueValue = issue(), comments = [] } = {}) => {
  const calls = { statuses: [], labels: [], comments: [] };
  return {
    calls,
    getIssue: () => issueValue,
    getComments: () => comments,
    setStatus: (...args) => calls.statuses.push(args),
    addLabel: (...args) => calls.labels.push(args),
    comment: (...args) => calls.comments.push(args),
  };
};

test("verified evidence turns green and adds the PR label", async () => {
  const url = "https://raw.githubusercontent.com/davifernan/excalidash/evidence/nil-621/light.png";
  const adapter = adapterFor({ comments: [{ body: `![light](${url})` }] });
  const result = await inspectPr({
    adapter,
    pr: pr(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "image/png" } }),
  });
  assert.equal(result.result, "satisfied");
  assert.deepEqual(adapter.calls.labels, [[192]]);
  assert.equal(adapter.calls.statuses[0][1], "success");
});

test("an unreachable evidence host is reported without turning red", async () => {
  const url = "https://raw.githubusercontent.com/davifernan/excalidash/evidence/nil-621/light.png";
  const adapter = adapterFor({ comments: [{ body: `![light](${url})` }] });
  const result = await inspectPr({
    adapter,
    pr: pr(),
    fetchImpl: async () => {
      throw new Error("temporary network failure");
    },
  });
  assert.equal(result.result, "ambiguous");
  assert.equal(result.reason, "evidence-url-unreachable");
  assert.deepEqual(adapter.calls.statuses, []);
  assert.equal(adapter.calls.comments.length, 1);
});

test("a reachable non-image evidence URL is a confident failure", async () => {
  const url = "https://raw.githubusercontent.com/davifernan/excalidash/evidence/nil-621/light.png";
  const adapter = adapterFor({ comments: [{ body: `![light](${url})` }] });
  const result = await inspectPr({
    adapter,
    pr: pr(),
    fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => "text/plain" } }),
  });
  assert.equal(result.result, "missing");
  assert.equal(result.reason, "evidence-url-not-an-image");
  assert.equal(adapter.calls.statuses[0][1], "failure");
  assert.match(adapter.calls.comments[0][1], /antwortet nicht mit einem abrufbaren Bild/);
});

test("an upstream server error is uncertain and therefore never red", async () => {
  const url = "https://raw.githubusercontent.com/davifernan/excalidash/evidence/nil-621/light.png";
  const adapter = adapterFor({ comments: [{ body: `![light](${url})` }] });
  const result = await inspectPr({
    adapter,
    pr: pr(),
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      headers: { get: () => "text/plain" },
    }),
  });
  assert.equal(result.result, "ambiguous");
  assert.equal(result.reason, "evidence-url-unreachable");
  assert.deepEqual(adapter.calls.statuses, []);
});

test("a confident missing image turns red once", async () => {
  const adapter = adapterFor();
  const result = await inspectPr({ adapter, pr: pr() });
  assert.equal(result.result, "missing");
  assert.equal(adapter.calls.statuses[0][1], "failure");
  assert.equal(adapter.calls.comments.length, 1);
});

test("ambiguous evidence reports without setting any status", async () => {
  const adapter = adapterFor({
    comments: [{ body: "![possible](https://uploads.example.test/proof.png)" }],
  });
  const result = await inspectPr({ adapter, pr: pr() });
  assert.equal(result.result, "ambiguous");
  assert.deepEqual(adapter.calls.statuses, []);
  assert.equal(adapter.calls.comments.length, 1);
});

test("one failing PR is reported as ambiguous without skipping later PRs", async () => {
  const first = adapterFor();
  first.setStatus = () => {
    throw new Error('gh "api" "repos/davifernan/excalidash/statuses/aaa" failed: HTTP 502');
  };
  const second = adapterFor();
  const adapters = new Map([
    [192, first],
    [193, second],
  ]);
  const adapter = {
    listOpenPrs: () => [pr(), pr({ number: 193 })],
    getIssue: () => issue(),
    getComments: (number) => {
      currentPr = number;
      return adapters.get(number).getComments(number);
    },
    setStatus: (...args) => adapters.get(currentPr).setStatus(...args),
    addLabel: (...args) => adapters.get(currentPr).addLabel(...args),
    comment: (...args) => adapters.get(currentPr).comment(...args),
  };
  let currentPr;

  const result = await runWatch({ adapter });

  assert.equal(result.events[0].result, "ambiguous");
  assert.equal(result.events[0].reason, "pr-inspection-failed");
  assert.match(result.events[0].error, /PR #192.*HTTP 502/);
  assert.equal(result.events[1].pr, 193);
  assert.equal(result.events[1].result, "missing");
  assert.equal(second.calls.statuses[0][1], "failure");
});
