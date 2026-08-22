#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const router = path.join(__dirname, "delivery-v2.cjs");

function route(issue, eventId) {
  return spawnSync(process.execPath, [router, "route"], {
    encoding: "utf8",
    input: JSON.stringify({
      issue,
      trigger: { kind: "package_dispatch", event_id: eventId },
    }),
  });
}

const slice = route({
  identifier: "NIL-331",
  metadata: {
    pipeline_schema_version: "2",
    delivery_model: "acceptance_slice",
    execution_unit: false,
  },
}, "probe-slice");
assert.equal(slice.status, 1, "acceptance slice must be rejected by the routing command");
const sliceResult = JSON.parse(slice.stdout);
assert.equal(sliceResult.dispatch, false, "acceptance slice must not dispatch an implementer");
assert.equal(sliceResult.code, "not-execution-unit");
process.stdout.write(`SLICE REJECTED: ${sliceResult.reason}\n`);

const ownershipPackage = route({
  identifier: "NIL-404",
  metadata: {
    pipeline_schema_version: "2",
    delivery_model: "ownership_package",
    execution_unit: true,
    package_status: "unclaimed",
  },
}, "probe-package");
assert.equal(ownershipPackage.status, 0, "ownership package must pass the routing command");
const packageResult = JSON.parse(ownershipPackage.stdout);
assert.equal(packageResult.dispatch, true, "ownership package must dispatch an implementer");
assert.equal(packageResult.code, "claimable");
process.stdout.write(
  `PACKAGE ADMITTED: ${packageResult.identifier} via ${packageResult.idempotencyKey}\n`,
);
