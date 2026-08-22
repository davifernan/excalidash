#!/usr/bin/env node

"use strict";

const SAFE_SKIP_REASON = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function formatSkippedEventLog(payload) {
  if (payload?.skip !== true) {
    throw new Error("Normalized payload is not a skipped event.");
  }

  const reason = payload.reason;
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.length > 64 ||
    !SAFE_SKIP_REASON.test(reason)
  ) {
    throw new Error("Skip reason is missing or unsafe.");
  }

  const lines = [`Event skipped: ${reason}`];
  if (reason === "event-without-pr") {
    lines.push("Event does not belong to a pull request.");
  }
  return `${lines.join("\n")}\n`;
}

function readNormalizedPayload(rawPayload) {
  try {
    return JSON.parse(rawPayload);
  } catch {
    throw new Error("Normalized payload is not valid JSON.");
  }
}

module.exports = { formatSkippedEventLog };

if (require.main === module) {
  try {
    const payload = readNormalizedPayload(process.env.PAYLOAD || "");
    process.stdout.write(formatSkippedEventLog(payload));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
