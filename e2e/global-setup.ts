import type { FullConfig } from "@playwright/test";

// Derived the way playwright.config.ts derives it. They used to disagree: the
// config honoured PORT, this file only honoured API_URL and otherwise
// hard-coded 8000. Moving the backend with PORT alone therefore left setup
// talking to whatever else was on 8000 -- nothing, or another run's instance --
// while the suite itself used the moved one.
const DEFAULT_BACKEND_PORT = 8000;
const BACKEND_PORT = Number(process.env.PORT) || DEFAULT_BACKEND_PORT;
const API_URL = process.env.API_URL || `http://localhost:${BACKEND_PORT}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitForBackend = async () => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${API_URL}/health`);
      if (resp.ok) return;
    } catch {
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for backend health at ${API_URL}/health`);
};

const getSetCookiePairs = (headers: Headers): string => {
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
  const fromGetter = typeof anyHeaders.getSetCookie === "function" ? anyHeaders.getSetCookie() : [];
  const raw = fromGetter.length > 0 ? fromGetter : [headers.get("set-cookie") || ""];
  const cookiePairs = raw
    .flatMap((v) => String(v || "").split(/,(?=[^;]+=[^;]+)/g))
    .map((v) => v.split(";")[0]?.trim() || "")
    .filter(Boolean);
  return cookiePairs.join("; ");
};

const completeAuthOnboardingIfNeeded = async () => {
  try {
    const statusResp = await fetch(`${API_URL}/auth/status`);
    if (statusResp.ok) {
      const status = (await statusResp.json()) as { authOnboardingRequired?: boolean };
      if (!status?.authOnboardingRequired) return;
    }
  } catch {
  }

  const csrfResp = await fetch(`${API_URL}/csrf-token`);
  if (!csrfResp.ok) {
    throw new Error(`Failed to fetch CSRF token: HTTP ${csrfResp.status}`);
  }
  const csrf = (await csrfResp.json()) as { token?: string; header?: string };
  const token = typeof csrf.token === "string" ? csrf.token : "";
  const headerName = typeof csrf.header === "string" && csrf.header ? csrf.header : "x-csrf-token";
  if (!token) throw new Error("Missing CSRF token from /csrf-token");

  const cookieHeader = getSetCookiePairs(csrfResp.headers);
  if (!cookieHeader) throw new Error("Missing CSRF client cookie from /csrf-token response");

  const choiceResp = await fetch(`${API_URL}/auth/onboarding-choice`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [headerName]: token,
      Cookie: cookieHeader,
    },
    body: JSON.stringify({ enableAuth: false }),
  });

  if (!choiceResp.ok && choiceResp.status !== 409) {
    const text = await choiceResp.text().catch(() => "");
    throw new Error(`Failed to apply onboarding choice: HTTP ${choiceResp.status} ${text}`);
  }
};

function assertMotionEvidenceVideoBoundary(config: FullConfig) {
  if (process.env.PLAYWRIGHT_MOTION_EVIDENCE !== "true") return;
  const projects = config.projects.map((project) => ({ name: project.name, video: project.use.video }));
  const successfulVideoProjects = projects.filter((project) => project.video === "on").map((project) => project.name);
  if (successfulVideoProjects.length !== 1 || successfulVideoProjects[0] !== "motion-evidence") {
    throw new Error(`Motion evidence video must be enabled only for motion-evidence; resolved: ${JSON.stringify(projects)}`);
  }
  for (const project of projects.filter((project) => project.name !== "motion-evidence")) {
    if (project.video !== "retain-on-failure") {
      throw new Error(`Motion evidence must not enable successful video for ${project.name}; got ${project.video}`);
    }
  }
}

export default async function globalSetup(config: FullConfig) {
  assertMotionEvidenceVideoBoundary(config);
  await waitForBackend();
  await completeAuthOnboardingIfNeeded();
}
