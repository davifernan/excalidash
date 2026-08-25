#!/usr/bin/env node

"use strict";

const MEASUREMENT_MARKER = "Hans-Review: skipped: measurement-only";
const SIGNAL_MARKER_VERSION = "v1";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function decideReviewPreflight({
  draft = false,
  authorType = "User",
  body = "",
  repository = "",
  headRepository = "",
  author = "unknown",
  association = "NONE",
  extraTrusted = "",
} = {}) {
  if (draft === true || draft === "true") {
    return skip("draft", "Der Pull Request ist ein Draft und nennt sich noch nicht review-ready.");
  }
  if (authorType === "Bot") {
    return skip("bot-author", `Der Autor \`${author}\` ist ein Bot.`);
  }
  if (headRepository !== repository) {
    return skip(
      "fork",
      `Der Head-Branch kommt aus dem Fork \`${headRepository}\`; dafür wird kein automatisches Review gestartet.`,
    );
  }

  const trustedLogins = new Set(String(extraTrusted).split(/\s+/).filter(Boolean));
  if (!TRUSTED_ASSOCIATIONS.has(association) && !trustedLogins.has(author)) {
    return skip(
      "untrusted-author",
      `Der Autor \`${author}\` ist mit GitHubs Zuordnung \`${association}\` nicht für automatische Reviews eingetragen.`,
    );
  }

  const hasMeasurementMarker = String(body)
    .split(/\r?\n/)
    .some((line) => line.trim() === MEASUREMENT_MARKER);
  if (hasMeasurementMarker) {
    return skip(
      "measurement-only",
      `Der PR-Text enthält die ausdrückliche Messmarkierung \`${MEASUREMENT_MARKER}\`.`,
    );
  }

  return { action: "admit", code: "review-candidate" };
}

function signalMarker(headSha, kind) {
  assertHeadSha(headSha);
  if (!new Set(["intentional-skip", "delivery-contract"]).has(kind)) {
    throw new Error(`Unsupported Hans signal kind: ${String(kind)}`);
  }
  return `<!-- excalidash-hans-signal:${SIGNAL_MARKER_VERSION} head=${headSha} kind=${kind} -->`;
}

function buildSignalComment({ headSha, decision = null, admission = null }) {
  assertHeadSha(headSha);
  const shortSha = headSha.slice(0, 12);

  if (decision?.action === "skip") {
    return [
      signalMarker(headSha, "intentional-skip"),
      `Hans-Friedrich wurde für \`${shortSha}\` bewusst nicht gestartet.`,
      "",
      `Grund: ${decision.reason}`,
      "",
      "`request-review` bleibt grün, weil dieses Nicht-Review beabsichtigt ist.",
    ].join("\n");
  }

  if (admission?.ok === false) {
    // Every violation, not just the first (NIL-585). `checkPrAdmission` used to
    // return at the first one, so a PR with three formal defects needed three
    // rounds -- each one only visible after the previous fix, each needing a
    // manual re-trigger. `findings` is the full list; older results that carry
    // only `message` still render as a single-item list.
    const findings = Array.isArray(admission.findings) && admission.findings.length > 0
      ? admission.findings
      : [{ message: admission.message || "Review admission failed without a message." }];
    const quote = (text) => String(text).split(/\r?\n/).map((line) => `> ${line}`).join("\n");
    const heading = findings.length === 1 ? "Verletzte Regel:" : `Verletzte Regeln (${findings.length}):`;
    const body = findings.length === 1
      ? quote(findings[0].message)
      : findings.map((finding, index) => `${index + 1}. ${String(finding.message).trim()}`).join("\n");
    return [
      signalMarker(headSha, "delivery-contract"),
      `Die Review-Zulassung für \`${shortSha}\` ist fehlgeschlagen; Hans-Friedrich wurde nicht gestartet.`,
      "",
      heading,
      "",
      body,
      "",
      "`request-review` bleibt rot, bis der PR-Text den Liefervertrag erfüllt.",
    ].join("\n");
  }

  throw new Error("A Hans signal comment requires an intentional skip or a failed admission result.");
}

function hasSignalComment(comments, headSha, kind) {
  const marker = signalMarker(headSha, kind);
  return comments.some((comment) => String(comment?.body || "").includes(marker));
}

function decideAdmissionEnforcement({ intentAction, admissionOutcome } = {}) {
  if (intentAction === "skip") {
    return {
      ok: true,
      code: "intentional-skip",
      annotation: "::notice::Intentional no-review outcome; request-review remains green.",
    };
  }
  if (intentAction === "admit" && admissionOutcome === "success") {
    return { ok: true, code: "admitted", annotation: "Review admission passed." };
  }
  if (intentAction === "admit" && admissionOutcome === "failure") {
    return {
      ok: false,
      code: "admission-failed",
      annotation:
        "::error::Review admission failed; the violated rule is in the Check review admission step log.",
    };
  }
  return {
    ok: false,
    code: "admission-not-run",
    annotation:
      "::error::Review admission did not complete; inspect the earlier failed workflow step.",
  };
}

function skip(code, reason) {
  return { action: "skip", code, reason };
}

function assertHeadSha(headSha) {
  if (!SHA_PATTERN.test(headSha || "")) {
    throw new Error("Hans signal comments require a 40-character lowercase head SHA.");
  }
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const input = JSON.parse(await readStdin());
  if (process.argv[2] === "preflight") {
    process.stdout.write(`${JSON.stringify(decideReviewPreflight(input))}\n`);
    return;
  }
  if (process.argv[2] === "enforce") {
    const result = decideAdmissionEnforcement(input);
    process.stdout.write(`${result.annotation}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: hans-review-signal.cjs preflight|enforce");
}

module.exports = {
  MEASUREMENT_MARKER,
  buildSignalComment,
  decideAdmissionEnforcement,
  decideReviewPreflight,
  hasSignalComment,
  signalMarker,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
