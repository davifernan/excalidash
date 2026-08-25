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
  const label = condition ? "PASS" : "FAIL";
  console.log(`${label}: ${message}: ${condition}`);
  assert.ok(condition, message);
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
  pass(`Dangerous URL blocked: ${url}`, sanitizeUrl(url) === "");
}

const allowedUrls = [
  "https://example.com",
  "/relative/path",
  "./current/path",
  "../parent/path",
  "mailto:test@example.com",
];
for (const url of allowedUrls) {
  pass(`Safe URL preserved: ${url}`, sanitizeUrl(url) === url);
}
console.log("");

console.log("Test 4: Text Sanitization with Length Limits");
const longText = "A".repeat(2000);
pass("Long text truncated to 500 characters", sanitizeText(longText, 500).length === 500);

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
pass("Drawing text sanitized", sanitizedDrawing.elements[0].text === "Malicious text");
pass("Drawing link sanitized", sanitizedDrawing.elements[1].link === "");
pass("Drawing preview scripts removed", !sanitizedDrawing.preview?.includes("<script>"));
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
pass("Legitimate text preserved", sanitizedLegitimate.elements[0].text === "Normal text content");
pass("Legitimate URL preserved", sanitizedLegitimate.elements[1].link === "https://example.com");
pass("Legitimate SVG preserved", sanitizedLegitimate.preview?.includes("<rect") === true);

console.log("\nSecurity Sanitization Tests: all assertions passed");
