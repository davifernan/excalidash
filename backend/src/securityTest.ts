import assert from "node:assert/strict";
import {
  sanitizeHtml,
  sanitizeSvg,
  sanitizeText,
  sanitizeUrl,
  validateImportedDrawing,
  sanitizeDrawingData,
} from "./security";

const pass = (message: string, condition: boolean): void => {
  assert.ok(condition, message);
  console.log(`PASS: ${message}`);
};

console.log("Starting Security Test Suite...\n");

console.log("Test 1: HTML/JS Sanitization");
const maliciousHtml = `
  <script>alert('XSS')</script>
  <img src="x" onerror="alert('XSS')">
  <iframe src="javascript:alert('XSS')"></iframe>
  <object data="javascript:alert('XSS')"></object>
  <embed src="javascript:alert('XSS')"></embed>
  Normal text content
`;
const sanitizedHtml = sanitizeHtml(maliciousHtml);
pass("Script tags removed", !sanitizedHtml.includes("<script>"));
pass("Event handlers removed", !sanitizedHtml.includes("onerror="));
pass("Malicious URLs blocked", !sanitizedHtml.includes("javascript:"));
pass("Safe HTML text preserved", sanitizedHtml.includes("Normal text content"));
console.log("");

console.log("Test 2: SVG Sanitization");
const maliciousSvg = `
  <svg>
    <script>alert('SVG XSS')</script>
    <rect href="javascript:alert('XSS')" />
    <foreignObject>
      <script>alert('XSS')</script>
    </foreignObject>
  </svg>
`;
const sanitizedSvg = sanitizeSvg(maliciousSvg);
pass("SVG scripts removed", !sanitizedSvg.includes("<script>"));
pass("Malicious SVG hrefs removed", !sanitizedSvg.includes("javascript:"));
pass("Safe SVG content preserved", sanitizedSvg.includes("<rect"));
console.log("");

console.log("Test 3: URL Sanitization");
const blockedUrls = [
  "javascript:alert('XSS')",
  "data:text/html,<script>alert('XSS')</script>",
  "vbscript:msgbox('XSS')",
];
for (const url of blockedUrls) {
  assert.equal(sanitizeUrl(url), "", `Dangerous URL must be blocked: ${url}`);
  console.log(`PASS: Dangerous URL blocked: ${url}`);
}

const allowedUrls = [
  "https://example.com",
  "/relative/path",
  "./current/path",
  "../parent/path",
  "mailto:test@example.com",
];
for (const url of allowedUrls) {
  assert.equal(sanitizeUrl(url), url, `Safe URL must be preserved: ${url}`);
  console.log(`PASS: Safe URL preserved: ${url}`);
}
console.log("");

console.log("Test 4: Text Sanitization with Length Limits");
const longText = "A".repeat(2000);
assert.equal(sanitizeText(longText, 500).length, 500, "Text must be truncated to its limit");
console.log("PASS: Long text truncated to 500 characters");

const maliciousText = "<script>alert('XSS')</script>Normal text";
const sanitizedText = sanitizeText(maliciousText);
pass("Text script tags removed", !sanitizedText.includes("<script>"));
pass("Safe text preserved", sanitizedText.includes("Normal text"));
console.log("");

console.log("Test 5: Drawing Data Sanitization");
const maliciousDrawing = {
  elements: [
    {
      id: "test1",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      angle: 0,
      version: 1,
      versionNonce: 1,
      text: "<script>alert('XSS')</script>Malicious text",
    },
    {
      id: "test2",
      type: "rectangle",
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      angle: 0,
      version: 1,
      versionNonce: 1,
      link: "javascript:alert('XSS')",
    },
  ],
  appState: {
    viewBackgroundColor: "<script>alert('XSS')</script>",
  },
  files: null,
  preview: '<svg><script>alert("XSS")</script></svg>',
};

pass(
  "Structurally valid drawing accepted for sanitization",
  validateImportedDrawing(maliciousDrawing),
);
const sanitizedDrawing = sanitizeDrawingData(maliciousDrawing);
assert.equal(sanitizedDrawing.elements[0].text, "Malicious text");
assert.equal(sanitizedDrawing.elements[1].link, "");
pass("Drawing preview scripts removed", !sanitizedDrawing.preview?.includes("<script>"));
console.log("PASS: Drawing text and link sanitized");
console.log("");

console.log("Test 6: Legitimate Drawing Validation");
const legitimateDrawing = {
  elements: [
    {
      id: "legit1",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      angle: 0,
      version: 1,
      versionNonce: 1,
      text: "Normal text content",
    },
    {
      id: "legit2",
      type: "rectangle",
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      angle: 0,
      version: 1,
      versionNonce: 1,
      link: "https://example.com",
    },
  ],
  appState: {
    viewBackgroundColor: "#ffffff",
  },
  files: null,
  preview: '<svg><rect width="100" height="100" fill="blue"/></svg>',
};

pass("Legitimate drawing accepted", validateImportedDrawing(legitimateDrawing));
const sanitizedLegitimate = sanitizeDrawingData(legitimateDrawing);
assert.equal(sanitizedLegitimate.elements[0].text, "Normal text content");
assert.equal(sanitizedLegitimate.elements[1].link, "https://example.com");
pass("Legitimate SVG preserved", sanitizedLegitimate.preview?.includes("<rect") === true);

console.log("\nSecurity Sanitization Tests: all assertions passed");
