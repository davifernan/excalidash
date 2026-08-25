#!/usr/bin/env node
/**
 * Counterprobe for scripts/deployment-drift-check.cjs (NIL-416).
 *
 * The production instance ran for a long time with no logging block because
 * its compose file is hand-maintained on the host, outside the repo, and
 * nobody noticed the block was missing. A check that has never been watched
 * to go red on that exact shape proves nothing. The first probe below plants
 * that literal regression against the real docker-compose.prod.yml in this
 * checkout; the rest cover the surrounding edges (anchors vs. inline blocks,
 * a missing service, an unreadable file) so the check does not cry wolf on a
 * legitimate deployment file either.
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { checkDrift } = require("./deployment-drift-check.cjs");

const repoRoot = path.resolve(__dirname, "..");
const CANONICAL_TEXT = fs.readFileSync(path.join(repoRoot, "docker-compose.prod.yml"), "utf8");
const LABEL = "docker-compose.prod.yml@test";

function withTempFile(contents, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deployment-drift-"));
  const file = path.join(dir, "docker-compose.yml");
  fs.writeFileSync(file, contents, "utf8");
  try {
    return callback(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const MINIMAL_NO_LOGGING = `services:
  backend:
    image: example/backend:latest
    mem_limit: 1500m
    memswap_limit: 1500m
    networks:
      - net

  frontend:
    image: example/frontend:latest
    mem_limit: 256m
    memswap_limit: 256m
    networks:
      - net

  bugsink:
    image: bugsink/bugsink:2.5.0
    profiles: ["observability"]
    mem_limit: 512m
    memswap_limit: 512m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

networks:
  net:
    driver: bridge
`;

const MINIMAL_WITH_MATCHING_LOGGING = `services:
  backend:
    image: example/backend:latest
    mem_limit: 1500m
    memswap_limit: 1500m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    networks:
      - net

  frontend:
    image: example/frontend:latest
    mem_limit: 256m
    memswap_limit: 256m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    networks:
      - net

  bugsink:
    image: bugsink/bugsink:2.5.0
    profiles: ["observability"]
    mem_limit: 512m
    memswap_limit: 512m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

networks:
  net:
    driver: bridge
`;

test("catches the real NIL-416 regression: the actual repo prod.yml vs. a deployment file with no logging block", () => {
  withTempFile(MINIMAL_NO_LOGGING, (deploymentPath) => {
    const result = checkDrift({ deploymentPath, canonicalText: CANONICAL_TEXT, canonicalLabel: LABEL });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((f) => f.includes('service "backend"') && f.includes("no logging block")),
      `expected a backend logging finding, got: ${JSON.stringify(result.findings)}`,
    );
    assert.ok(
      result.findings.some((f) => f.includes('service "frontend"') && f.includes("no logging block")),
      `expected a frontend logging finding, got: ${JSON.stringify(result.findings)}`,
    );
  });
});

test("passes once the deployment file's logging block matches, even written inline instead of via anchor", () => {
  withTempFile(MINIMAL_WITH_MATCHING_LOGGING, (deploymentPath) => {
    const result = checkDrift({ deploymentPath, canonicalText: CANONICAL_TEXT, canonicalLabel: LABEL });
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });
});

test("flags a max-size that quietly reverted, not just a missing block", () => {
  const drifted = MINIMAL_WITH_MATCHING_LOGGING.replace('max-size: "10m"', 'max-size: "5m"');
  withTempFile(drifted, (deploymentPath) => {
    const result = checkDrift({ deploymentPath, canonicalText: CANONICAL_TEXT, canonicalLabel: LABEL });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((f) => f.includes('service "backend"') && f.includes("logging mismatch")),
      `expected a logging mismatch finding, got: ${JSON.stringify(result.findings)}`,
    );
  });
});

test("flags a mem_limit that reverted to a different value", () => {
  const drifted = MINIMAL_WITH_MATCHING_LOGGING.replace("mem_limit: 1500m", "mem_limit: 512m");
  withTempFile(drifted, (deploymentPath) => {
    const result = checkDrift({ deploymentPath, canonicalText: CANONICAL_TEXT, canonicalLabel: LABEL });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((f) => f.includes('service "backend"') && f.includes("mem_limit mismatch")),
      `expected a mem_limit mismatch finding, got: ${JSON.stringify(result.findings)}`,
    );
  });
});

test("flags a service present upstream but entirely missing from the deployment file", () => {
  const missingFrontend = MINIMAL_WITH_MATCHING_LOGGING.replace(
    /\n  frontend:[\s\S]*?(?=\n  bugsink:)/,
    "\n",
  );
  withTempFile(missingFrontend, (deploymentPath) => {
    const result = checkDrift({ deploymentPath, canonicalText: CANONICAL_TEXT, canonicalLabel: LABEL });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((f) => f.includes('service "frontend"') && f.includes("not in")),
      `expected a missing-service finding, got: ${JSON.stringify(result.findings)}`,
    );
  });
});

test("still requires a profile-gated service in the deployment definition", () => {
  const missingBugsink = MINIMAL_WITH_MATCHING_LOGGING.replace(
    /\n  bugsink:[\s\S]*?(?=\nnetworks:)/,
    "\n",
  );
  withTempFile(missingBugsink, (deploymentPath) => {
    const result = checkDrift({ deploymentPath, canonicalText: CANONICAL_TEXT, canonicalLabel: LABEL });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((f) => f.includes('service "bugsink"') && f.includes("not in")),
      `expected a missing Bugsink finding, got: ${JSON.stringify(result.findings)}`,
    );
  });
});

test("fails closed, not silently, when the deployment file cannot be read", () => {
  const result = checkDrift({
    deploymentPath: "/nonexistent/does-not-exist/docker-compose.yml",
    canonicalText: CANONICAL_TEXT,
    canonicalLabel: LABEL,
  });
  assert.equal(result.ok, false);
  assert.ok(result.findings.length > 0);
  assert.ok(result.findings[0].includes("cannot read deployment compose file"));
});

test("does not cry wolf over the deliberate host-only differences in the real deployment file's shape", () => {
  // Same values as docker-compose.prod.yml's backend/frontend for the checked
  // keys, but with the host-specific extras (loopback ports, hardcoded
  // FRONTEND_URL, extra backend port) this deployment legitimately carries.
  const realisticDeployment = `services:
  backend:
    image: ghcr.io/davifernan/excalidash-backend:\${EXCALIDASH_IMAGE_TAG:?set EXCALIDASH_IMAGE_TAG to a verified sha tag}
    mem_limit: 1500m
    memswap_limit: 1500m
    environment:
      - TRUST_PROXY=true
      - FRONTEND_URL=https://draw.nilo.live
    ports:
      - "127.0.0.1:6768:8000"
    networks:
      - net
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  frontend:
    image: ghcr.io/davifernan/excalidash-frontend:\${EXCALIDASH_IMAGE_TAG:?set EXCALIDASH_IMAGE_TAG to a verified sha tag}
    mem_limit: 256m
    memswap_limit: 256m
    ports:
      - "127.0.0.1:6770:80"
    networks:
      - net
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  bugsink:
    image: bugsink/bugsink:2.5.0
    profiles: ["observability"]
    mem_limit: 512m
    memswap_limit: 512m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

networks:
  net:
    driver: bridge
`;
  withTempFile(realisticDeployment, (deploymentPath) => {
    const result = checkDrift({ deploymentPath, canonicalText: CANONICAL_TEXT, canonicalLabel: LABEL });
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });
});
