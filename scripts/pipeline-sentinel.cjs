#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildImpactManifest, checkPrAdmission } = require("./delivery-v2.cjs");

const ACTIVE_RUN_STATES = new Set(["queued", "running"]);
const RECOVERABLE_ISSUE_STATES = new Set(["todo", "in_progress"]);
const COMPLETE_ISSUE_STATES = new Set(["done", "closed", "cancelled", "canceled"]);
const OPEN_PR_STATES = new Set(["open", "opened", "draft"]);
const RECOVERY_BUDGET = 2;
const LOCK_STALE_MS = 10 * 60 * 1000;
const READY_GRACE_MS = 5 * 60 * 1000;
const STATE_SCHEMA = 1;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(snapshot) {
  const latestRun = latestByCreatedAt(snapshot.runs || []);
  const openPr = (snapshot.pullRequests || []).find((pr) => OPEN_PR_STATES.has(pr.state));
  const material = {
    package: snapshot.issue.identifier,
    issue_status: snapshot.issue.status,
    latest_run_id: latestRun?.id || null,
    latest_run_status: latestRun?.status || null,
    pr: openPr?.number || null,
    head_sha: openPr?.head_sha || openPr?.headRefOid || null,
    main_sha: snapshot.mainSha || null,
  };
  return crypto.createHash("sha256").update(stableJson(material)).digest("hex");
}

function latestByCreatedAt(items) {
  return [...items].sort((left, right) => {
    const time = Date.parse(right.created_at || right.createdAt || "") - Date.parse(left.created_at || left.createdAt || "");
    if (time !== 0) return time;
    return String(right.id || "").localeCompare(String(left.id || ""));
  })[0] || null;
}

function hasLiveLease(issue, now = Date.now()) {
  const expiresAt = Date.parse(issue.metadata?.controller_lease_expires_at || "");
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function classifyPackage(snapshot, now = Date.now()) {
  const issue = snapshot.issue;
  const activeRuns = (snapshot.runs || []).filter((run) => ACTIVE_RUN_STATES.has(run.status));
  const openPrs = (snapshot.pullRequests || []).filter((pr) => OPEN_PR_STATES.has(pr.state));
  const activeSignals = {
    task: activeRuns.length > 0,
    pull_request: openPrs.length > 0,
    lease: hasLiveLease(issue, now),
  };
  const active = Object.values(activeSignals).some(Boolean);
  const assigned = Boolean(issue.assignee_id);
  const recoverable = RECOVERABLE_ISSUE_STATES.has(issue.status) && assigned && !active;

  return {
    active,
    activeSignals,
    anomaly: recoverable ? "stalled-package" : null,
    action: recoverable ? "rerun-package-owner" : null,
    latestRun: latestByCreatedAt(snapshot.runs || []),
  };
}

function parseDependencies(issue) {
  const raw = issue.metadata?.depends_on;
  if (!raw || raw === "none") return [];
  if (Array.isArray(raw)) return raw.map(String);
  return String(raw).split(/[\s,]+/).filter((value) => /^NIL-\d+$/i.test(value)).map((value) => value.toUpperCase());
}

function executablePackages(packages) {
  const byIdentifier = new Map(packages.map((issue) => [issue.identifier, issue]));
  return packages.filter((issue) => {
    if (issue.metadata?.execution_unit !== true) return false;
    if (COMPLETE_ISSUE_STATES.has(issue.status)) return false;
    if (issue.assignee_id || issue.metadata?.package_status === "implementing") return false;
    return parseDependencies(issue).every((identifier) => {
      const dependency = byIdentifier.get(identifier);
      return dependency && COMPLETE_ISSUE_STATES.has(dependency.status);
    });
  });
}

function isReviewReady(pr, impactManifest) {
  const authorType = pr.authorType || (pr.author?.is_bot ? "Bot" : "User");
  return checkPrAdmission({
    body: pr.body || "",
    draft: Boolean(pr.isDraft || pr.draft),
    authorType,
    impactManifest,
  }).ok;
}

function hasCurrentHansReview(reviews, headSha) {
  return (reviews || []).some((review) => {
    const login = review.user?.login || review.author?.login;
    const body = review.body || "";
    return login === "the-hans-friedrich[bot]" &&
      body.includes("excalidash-review:v1") &&
      (review.commit_id === headSha || body.includes(headSha));
  });
}

function hansAnomaly(pr, reviews, impactManifest, now = Date.now()) {
  if (!isReviewReady(pr, impactManifest) || hasCurrentHansReview(reviews, pr.headRefOid)) return null;
  const updatedAt = Date.parse(pr.updatedAt || pr.updated_at || pr.createdAt || "");
  if (Number.isFinite(updatedAt) && now - updatedAt < READY_GRACE_MS) return null;
  return {
    key: `hans:${pr.number}:${pr.headRefOid}`,
    action: "trigger-hans",
    pr: pr.number,
    headSha: pr.headRefOid,
  };
}

function packageQaDue(issue, mainSha) {
  const metadata = issue.metadata || {};
  const countDue = Number(metadata.integrated_prs_since_qa_anchor || 0) >=
    Number(metadata.qa_checkpoint_max_prs || 3);
  const completionDue = ["awaiting_qa", "qa_due"].includes(metadata.package_status) &&
    metadata.last_qa_sha !== mainSha;
  return countDue || completionDue;
}

function qaDue(packages, mainSha) {
  return packages.some((issue) => packageQaDue(issue, mainSha));
}

function emptyState() {
  return { schema: STATE_SCHEMA, observations: {}, incidents: {} };
}

function loadState(stateFile) {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return value.schema === STATE_SCHEMA ? value : emptyState();
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw error;
  }
}

function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, stateFile);
}

function observe(state, key, anomalyFingerprint, nowIso) {
  const previous = state.observations[key];
  if (!previous || previous.fingerprint !== anomalyFingerprint) {
    state.observations[key] = {
      fingerprint: anomalyFingerprint,
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      observations: 1,
    };
    return { shouldAct: false, observations: 1 };
  }
  previous.last_seen_at = nowIso;
  previous.observations += 1;
  const incident = state.incidents[key] || { recovery_attempts: 0 };
  state.incidents[key] = incident;
  return {
    shouldAct: previous.observations >= 2 && incident.recovery_attempts < RECOVERY_BUDGET,
    exhausted: incident.recovery_attempts >= RECOVERY_BUDGET,
    observations: previous.observations,
  };
}

function recordAction(state, key, nowIso) {
  const incident = state.incidents[key] || { recovery_attempts: 0 };
  incident.recovery_attempts += 1;
  incident.last_action_at = nowIso;
  state.incidents[key] = incident;
  return incident.recovery_attempts;
}

function clearObservation(state, key) {
  delete state.observations[key];
  delete state.incidents[key];
}

function acquireLock(lockFile, now = Date.now()) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  try {
    const descriptor = fs.openSync(lockFile, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, acquired_at: new Date(now).toISOString() })}\n`);
    return () => {
      fs.closeSync(descriptor);
      try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
    };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const age = now - fs.statSync(lockFile).mtimeMs;
    if (age <= LOCK_STALE_MS) return null;
    fs.unlinkSync(lockFile);
    return acquireLock(lockFile, now);
  }
}

function commandJson(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const safeMessage = String(result.stderr || "command failed").trim().split("\n")[0];
    throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed: ${safeMessage}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${command} returned invalid JSON`);
  }
}

function commandText(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed`);
  return result.stdout.trim();
}

function createLiveAdapter(config) {
  const multica = (...args) => commandJson("multica", [...args, "--output", "json"], { cwd: config.repoPath });
  const gh = (...args) => commandJson("gh", args, { cwd: config.repoPath });
  let openPullRequests = null;
  const getOpenPullRequests = () => {
    if (!openPullRequests) {
      openPullRequests = gh(
        "pr", "list",
        "--repo", config.repository,
        "--state", "open",
        "--limit", "100",
        "--json", "number,isDraft,body,headRefOid,baseRefOid,updatedAt,url,author,labels",
      );
    }
    return openPullRequests;
  };
  return {
    listPackages() {
      return multica("issue", "list", "--project", config.projectId, "--metadata", "execution_unit=true", "--limit", "200").issues;
    },
    getIssue(identifier) { return multica("issue", "get", identifier); },
    getRuns(identifier) { return multica("issue", "runs", identifier); },
    getPullRequests(identifier) {
      const githubByNumber = new Map(getOpenPullRequests().map((pr) => [pr.number, pr]));
      return multica("issue", "pull-requests", identifier).pull_requests.map((pr) => ({
        ...pr,
        head_sha: githubByNumber.get(pr.number)?.headRefOid || null,
      }));
    },
    getMainSha() {
      return commandText("gh", ["api", `repos/${config.repository}/git/ref/heads/main`, "--jq", ".object.sha"], { cwd: config.repoPath });
    },
    listOpenPullRequests() { return getOpenPullRequests(); },
    getPrReviews(number) {
      return gh("api", `repos/${config.repository}/pulls/${number}/reviews`);
    },
    getPrImpactManifest(pr) {
      const files = gh(
        "api",
        `repos/${config.repository}/pulls/${pr.number}/files`,
        "--paginate",
        "--slurp",
        "--jq", "add | map(.filename)",
      );
      return buildImpactManifest({
        baseSha: pr.baseRefOid,
        headSha: pr.headRefOid,
        files,
        labels: pr.labels || [],
      });
    },
    rerun(identifier) { return multica("issue", "rerun", identifier); },
    setMetadata(identifier, key, value) {
      return multica("issue", "metadata", "set", identifier, "--key", key, "--value", String(value));
    },
    comment(identifier, content) {
      return multica("issue", "comment", "add", identifier, "--content", content);
    },
    getHansWebhook() {
      const details = multica("autopilot", "get", config.hansAutopilotId, "--show-secrets");
      const trigger = details.triggers?.find((candidate) => candidate.kind === "webhook" && candidate.enabled);
      if (!trigger?.webhook_url) throw new Error("Hans webhook is unavailable");
      return trigger.webhook_url;
    },
    triggerQa() {
      if (!config.qaAutopilotId) throw new Error("Package-QA autopilot is not configured");
      return multica("autopilot", "trigger", config.qaAutopilotId);
    },
  };
}

async function triggerHans(adapter, config, anomaly) {
  const response = await fetch(adapter.getHansWebhook(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `${config.repository}#${anomaly.pr}@${anomaly.headSha}`,
    },
    body: JSON.stringify({
      event: "pull_request",
      action: "sentinel_recovery",
      repo: config.repository,
      pr: anomaly.pr,
      head_sha: anomaly.headSha,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Hans webhook returned HTTP ${response.status}`);
  const body = await response.json();
  if (!["accepted", "duplicate"].includes(body.status)) throw new Error(`Hans webhook returned ${body.status || "unknown"}`);
  return body.status;
}

async function attemptPackageRecovery({ adapter, config, issue, expectedFingerprint, lockRoot, dryRun }) {
  const lockFile = path.join(lockRoot, `${issue.identifier}-${expectedFingerprint}.lock`);
  const release = acquireLock(lockFile);
  if (!release) return { result: "already-recovered", reason: "singleflight-lock-held" };
  try {
    adapter.refreshPullRequests?.();
    const freshIssue = adapter.getIssue(issue.identifier);
    const fresh = {
      issue: freshIssue,
      runs: adapter.getRuns(issue.identifier),
      pullRequests: adapter.getPullRequests(issue.identifier),
      mainSha: adapter.getMainSha(),
    };
    const freshClassification = classifyPackage(fresh);
    if (freshClassification.active || fingerprint(fresh) !== expectedFingerprint) {
      return { result: "already-recovered", reason: "state-changed-before-mutation" };
    }
    if (dryRun) return { result: "dry-run", action: "rerun-package-owner" };
    const rerun = adapter.rerun(issue.identifier);
    return { result: "recovered", action: "rerun-package-owner", runId: rerun.id || rerun.task_id || null };
  } finally {
    release();
  }
}

function metadataWrites(adapter, identifier, values, dryRun) {
  if (dryRun) return;
  for (const [key, value] of Object.entries(values)) adapter.setMetadata(identifier, key, value);
}

async function scan({ adapter, config, now = new Date(), dryRun = false }) {
  const nowIso = now.toISOString();
  const state = loadState(config.stateFile);
  const mainSha = adapter.getMainSha();
  const packages = adapter.listPackages();
  const snapshots = [];
  const events = [];

  for (const listedIssue of packages) {
    const snapshot = {
      issue: adapter.getIssue(listedIssue.identifier),
      runs: adapter.getRuns(listedIssue.identifier),
      pullRequests: adapter.getPullRequests(listedIssue.identifier),
      mainSha,
    };
    snapshots.push(snapshot);
    const classification = classifyPackage(snapshot, now.getTime());
    const key = `package:${snapshot.issue.identifier}`;
    if (!classification.anomaly) {
      clearObservation(state, key);
      continue;
    }
    const currentFingerprint = fingerprint(snapshot);
    const observation = observe(state, key, currentFingerprint, nowIso);
    metadataWrites(adapter, snapshot.issue.identifier, {
      watchdog_last_fingerprint: currentFingerprint,
      watchdog_last_seen_at: nowIso,
      watchdog_recovery_attempts: state.incidents[key]?.recovery_attempts || 0,
      last_reconciled_at: nowIso,
    }, dryRun);
    if (!observation.shouldAct) {
      events.push({ type: "observed", issue: snapshot.issue.identifier, fingerprint: currentFingerprint, exhausted: observation.exhausted || false });
      const incident = state.incidents[key];
      if (observation.exhausted && !incident?.escalated_at) {
        if (!dryRun) {
          adapter.comment(config.masterIssue, `SENTINEL ALERT — Recovery-Budget erschöpft\n\nPackage: ${snapshot.issue.identifier}\nStatus: ${snapshot.issue.status}\nLatest Run: ${classification.latestRun?.id || "keiner"} (${classification.latestRun?.status || "kein Status"})\nMain: ${mainSha}\nFingerprint: ${currentFingerprint}\nVersuche: ${incident.recovery_attempts}\nAktion: automatische Recovery für diesen Zustand gestoppt; Controller-Diagnose erforderlich.\n\nGenerated by Pipeline Sentinel`);
          incident.escalated_at = nowIso;
        }
        events.push({ type: "controller-alert", issue: snapshot.issue.identifier, result: dryRun ? "dry-run" : "commented" });
      }
      continue;
    }
    const result = await attemptPackageRecovery({
      adapter,
      config,
      issue: snapshot.issue,
      expectedFingerprint: currentFingerprint,
      lockRoot: config.lockRoot,
      dryRun,
    });
    if (result.result === "recovered") {
      const attempts = recordAction(state, key, nowIso);
      metadataWrites(adapter, snapshot.issue.identifier, {
        watchdog_last_action_at: nowIso,
        watchdog_recovery_attempts: attempts,
        watchdog_suppressed_until: new Date(now.getTime() + config.intervalMs).toISOString(),
      }, dryRun);
    }
    events.push({ type: "recovery", issue: snapshot.issue.identifier, ...result });
  }

  const anyActiveImplementation = snapshots.some((snapshot) => classifyPackage(snapshot, now.getTime()).active);
  const eligible = executablePackages(packages);
  const idleKey = "global:idle-master";
  if (!anyActiveImplementation && eligible.length > 0) {
    const idleFingerprint = crypto.createHash("sha256").update(stableJson({ eligible: eligible.map((issue) => issue.identifier).sort(), mainSha })).digest("hex");
    const observation = observe(state, idleKey, idleFingerprint, nowIso);
    if (observation.shouldAct) {
      if (!dryRun) {
        adapter.comment(config.masterIssue, `SENTINEL RECOVERY — keine aktive Implementierung\n\nAusführbare Packages: ${eligible.map((issue) => issue.identifier).join(", ")}\nMain: ${mainSha}\nFingerprint: ${idleFingerprint}\nAktion: Master-Orchestrator aufwecken; keine Produktentscheidung getroffen.\n\nGenerated by Pipeline Sentinel`);
        recordAction(state, idleKey, nowIso);
      }
      events.push({ type: "master-wake", packages: eligible.map((issue) => issue.identifier), result: dryRun ? "dry-run" : "commented" });
    }
  } else {
    clearObservation(state, idleKey);
  }

  for (const pr of adapter.listOpenPullRequests()) {
    const impactManifest = adapter.getPrImpactManifest(pr);
    if (!isReviewReady(pr, impactManifest)) continue;
    const anomaly = hansAnomaly(pr, adapter.getPrReviews(pr.number), impactManifest, now.getTime());
    if (!anomaly) {
      clearObservation(state, `pr:${pr.number}`);
      continue;
    }
    const key = `pr:${pr.number}`;
    const observation = observe(state, key, anomaly.key, nowIso);
    if (!observation.shouldAct) continue;
    if (dryRun) {
      events.push({ type: "hans-recovery", pr: pr.number, result: "dry-run" });
      continue;
    }
    adapter.refreshPullRequests?.();
    const currentPr = adapter.listOpenPullRequests().find((candidate) => candidate.number === pr.number);
    const currentReviews = currentPr ? adapter.getPrReviews(pr.number) : [];
    const currentImpactManifest = currentPr ? adapter.getPrImpactManifest(currentPr) : null;
    if (
      !currentPr ||
      currentPr.headRefOid !== pr.headRefOid ||
      !isReviewReady(currentPr, currentImpactManifest) ||
      hasCurrentHansReview(currentReviews, pr.headRefOid)
    ) {
      events.push({ type: "hans-recovery", pr: pr.number, result: "already-recovered" });
      continue;
    }
    const result = await triggerHans(adapter, config, anomaly);
    recordAction(state, key, nowIso);
    events.push({ type: "hans-recovery", pr: pr.number, result });
  }

  const qaKey = "global:package-qa";
  const duePackages = packages.filter((issue) => packageQaDue(issue, mainSha));
  if (qaDue(packages, mainSha)) {
    const qaState = duePackages.map((issue) => ({
      package: issue.identifier,
      anchor: issue.metadata?.qa_anchor_sha || issue.metadata?.last_qa_sha || null,
      integrations: Number(issue.metadata?.integrated_prs_since_qa_anchor || 0),
      status: issue.metadata?.package_status || null,
    }));
    const qaFingerprint = crypto.createHash("sha256").update(stableJson({ mainSha, packages: qaState })).digest("hex");
    const observation = observe(state, qaKey, qaFingerprint, nowIso);
    if (observation.shouldAct) {
      let result = "dry-run";
      if (!dryRun) {
        if (config.qaAutopilotId) {
          adapter.triggerQa();
          result = "qa-triggered";
        } else {
          adapter.comment(config.masterIssue, `SENTINEL RECOVERY — Package QA ist fällig\n\nPackages: ${duePackages.map((issue) => issue.identifier).join(", ")}\nMain: ${mainSha}\nPackage-Zustand: ${qaState.map((entry) => `${entry.package} anchor=${entry.anchor || "nicht gesetzt"} integrations=${entry.integrations} status=${entry.status || "nicht gesetzt"}`).join("; ")}\nAktion: Package-QA-Agent starten.\n\nGenerated by Pipeline Sentinel`);
          result = "master-alerted";
        }
        recordAction(state, qaKey, nowIso);
      }
      events.push({ type: "qa-recovery", result });
    }
  } else {
    clearObservation(state, qaKey);
  }

  metadataWrites(adapter, config.masterIssue, { last_reconciled_at: nowIso }, dryRun);
  saveState(config.stateFile, state);
  return { ok: true, checkedAt: nowIso, mainSha, packages: packages.length, events };
}

function readConfig() {
  const repoPath = process.env.SENTINEL_REPO_PATH || process.cwd();
  const stateFile = process.env.SENTINEL_STATE_FILE || path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME, ".local", "state"), "excalidash-pipeline-sentinel", "state.json");
  const config = {
    projectId: process.env.MULTICA_PROJECT_ID,
    repository: process.env.SENTINEL_REPOSITORY || "davifernan/excalidash",
    repoPath,
    mainRef: process.env.SENTINEL_MAIN_REF || "own/main",
    stateFile,
    lockRoot: `${stateFile}.locks`,
    masterIssue: process.env.SENTINEL_MASTER_ISSUE || "NIL-383",
    hansAutopilotId: process.env.SENTINEL_HANS_AUTOPILOT_ID || "0957dd3a-f30c-4a5b-b7b4-24733122bf2b",
    qaAutopilotId: process.env.SENTINEL_QA_AUTOPILOT_ID || null,
    intervalMs: Number(process.env.SENTINEL_INTERVAL_MS || 180_000),
  };
  if (!config.projectId) throw new Error("MULTICA_PROJECT_ID is required");
  return config;
}

module.exports = {
  acquireLock,
  attemptPackageRecovery,
  classifyPackage,
  executablePackages,
  fingerprint,
  hansAnomaly,
  hasCurrentHansReview,
  isReviewReady,
  observe,
  qaDue,
  recordAction,
  scan,
  stableJson,
};

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  let releaseProcessLock = null;
  try {
    const config = readConfig();
    releaseProcessLock = acquireLock(`${config.stateFile}.process.lock`);
    if (!releaseProcessLock) {
      process.stdout.write(`${JSON.stringify({ ok: true, result: "already-running" })}\n`);
    } else {
      scan({ adapter: createLiveAdapter(config), config, dryRun })
        .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
        .catch((error) => {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = 1;
        })
        .finally(() => releaseProcessLock());
    }
  } catch (error) {
    if (releaseProcessLock) releaseProcessLock();
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
