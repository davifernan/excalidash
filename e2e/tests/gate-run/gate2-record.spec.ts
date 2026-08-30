import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import { API_URL, getCsrfHeaders } from "../helpers/api";
import { grantDrawingPermission, loginViaApi, loginViaUi } from "../helpers/authLifecycle";
import { gate2PresenceFixture } from "../fixtures/agentContextGateFixtures";

/**
 * NIL-701 stage recording for Gate 2. Run this AFTER
 * `backend/scripts/gate-run/setup-gate2.ts` has written
 * `backend/scripts/gate-run/output/gate2-state.json`. It does not answer
 * Gate 2's question and does not judge anything -- it only:
 *
 *  1. Opens the board as the owner (Davi's own real view, for screenshots).
 *  2. Opens a SECOND, separately authenticated browser context as the
 *     foreign observer and inspects raw WebSocket frames for the private
 *     run's own identity riding on any of the four `privateEventNames` --
 *     this is the actual Gate 2 privacy signal, not a stand-in for it. The
 *     three public runs legitimately produce the same event names
 *     constantly; matching by event name alone would flag that expected
 *     traffic too, so the check also requires the private run's runId in
 *     the frame.
 *  3. Triggers the real focus/runtime tool-call route itself, repeatedly,
 *     for the whole recording window, using the OWNER's own authenticated
 *     session (the same route setup-gate2.ts used to call once, up front --
 *     moved here because a one-shot trigger goes stale
 *     (`BOARD_AGENT_PRESENCE_STALE_MS`, 8s) and gets pruned long before this
 *     separately-run spec's observer socket ever connects, which made the
 *     privacy assertion below pass against zero live events every time,
 *     proof of nothing. Re-triggering every 4s here also keeps presence
 *     genuinely visible across all six samples (0-25s), the way a real,
 *     continuously active agent would.
 *  4. Takes six screenshots of the owner's view at the fixture's sample
 *     seconds (0/5/10/15/20/25) without prompting Davi or reading his
 *     answers -- the screenshots are the retained artifact, not the
 *     measurement.
 *
 * Requires env vars: GATE_OWNER_EMAIL, GATE_OWNER_PASSWORD,
 * GATE_OBSERVER_EMAIL, GATE_OBSERVER_PASSWORD (an existing second account
 * with no other relationship to this drawing -- grantDrawingPermission
 * below gives it exactly "view"), and GATE2_MOUNT_TOKENS -- the
 * `export GATE2_MOUNT_TOKENS=...` line setup-gate2.ts printed to its own
 * stdout, copied into this shell. Mount capability tokens are never written
 * to `gate2-state.json` or any other file: `AgentRunMount` stores only a
 * hash and never expires, so a file is something a later `git add -A` or
 * backup can pick up without anyone noticing (see setup-gate2.ts's header).
 *
 * Command: npx playwright test gate-run/gate2-record.spec.ts --project=gate-run
 */

const STATE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "backend",
  "scripts",
  "gate-run",
  "output",
  "gate2-state.json",
);
const OUT_DIR = path.resolve(__dirname, "output", "gate2");

type Gate2State = {
  drawingId: string;
  boardUrl: string;
  mounts: Record<string, { runId: string; contextId: string }>;
};

const TRIGGER_INTERVAL_MS = 4_000;
const RECORDING_TAIL_MS = 2_000;

test("records the observer's private-event capture and six timestamped board screenshots", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const ownerEmail = process.env.GATE_OWNER_EMAIL;
  const ownerPassword = process.env.GATE_OWNER_PASSWORD;
  const observerEmail = process.env.GATE_OBSERVER_EMAIL;
  const observerPassword = process.env.GATE_OBSERVER_PASSWORD;
  if (!ownerEmail || !ownerPassword || !observerEmail || !observerPassword) {
    throw new Error(
      "Set GATE_OWNER_EMAIL, GATE_OWNER_PASSWORD, GATE_OBSERVER_EMAIL, GATE_OBSERVER_PASSWORD " +
        "before running this -- see materials/gate2-instructions.md.",
    );
  }
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(`${STATE_PATH} not found -- run setup-gate2.ts first.`);
  }
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Gate2State;
  const mountTokensEnv = process.env.GATE2_MOUNT_TOKENS;
  if (!mountTokensEnv) {
    throw new Error(
      "Set GATE2_MOUNT_TOKENS -- the export line setup-gate2.ts printed to its " +
        "own stdout when it ran, copied into this shell. It is never written to " +
        "gate2-state.json or any other file (see this spec's own header comment).",
    );
  }
  const mountTokens = JSON.parse(mountTokensEnv) as Record<string, string>;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Grant the observer plain view access, and nothing more, using the
  // owner's own authenticated context -- the same grant a real teammate
  // would receive, not a privileged test shortcut.
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await loginViaUi(ownerPage, { email: ownerEmail, password: ownerPassword });
  const drawingId = state.drawingId;

  // grantDrawingPermission takes a user ID, not an email
  // (drawingSharingRoutes.ts looks the grantee up by `id`) -- resolve it via
  // a throwaway API login rather than guessing it from the address.
  const resolverContext = await browser.newContext();
  const observerAccount = await loginViaApi(resolverContext.request, {
    email: observerEmail,
    password: observerPassword,
  });
  await resolverContext.close();
  await grantDrawingPermission(ownerContext.request, drawingId, observerAccount.id, "view");

  // The foreign observer: a second, independently authenticated browser
  // context (its own cookies, its own socket connection).
  const observerContext = await browser.newContext();
  const observerPage = await observerContext.newPage();
  await loginViaUi(observerPage, { email: observerEmail, password: observerPassword });

  // The private run's own identity, not just its event NAME -- the three
  // public runs legitimately produce the exact same event names constantly
  // (audience: {kind:"drawing"}, correctly visible to everyone including the
  // observer), so matching on event name alone flags that legitimate,
  // expected traffic as if it were the leak. The real question is whether a
  // frame naming one of these event types also carries the PRIVATE run's own
  // identity.
  const PRIVATE_RUN_ID = gate2PresenceFixture.privateAgent.runId;
  const startedAt = Date.now();
  // Playwright's page.on("websocket") only fires for connections made AFTER
  // the listener is attached -- attaching it after page.goto() misses the
  // connection the page itself opens on load. Both listeners are attached
  // here, before either page navigates.
  const listenFor = (page: typeof ownerPage) => {
    const captured: { atMs: number; eventName: string; frame: string }[] = [];
    page.on("websocket", (ws) => {
      ws.on("framereceived", (frame) => {
        const payload = typeof frame.payload === "string" ? frame.payload : "";
        for (const eventName of gate2PresenceFixture.privateEventNames) {
          if (payload.includes(eventName) && payload.includes(PRIVATE_RUN_ID)) {
            captured.push({ atMs: Date.now() - startedAt, eventName, frame: payload });
          }
        }
      });
    });
    return captured;
  };
  // The owner's own socket is a positive control: the private run's events
  // are addressed to the owner (audience: {kind:"private", userId: owner.id}),
  // so seeing them here proves the trigger loop below is producing real,
  // observable live events at all -- not just that nothing reached the
  // observer because nothing was ever broadcast.
  const ownerCaptured = listenFor(ownerPage);
  const observerCaptured = listenFor(observerPage);
  await ownerPage.goto(state.boardUrl);
  await observerPage.goto(state.boardUrl);

  // Trigger the real tool-call route for every run, repeatedly, using the
  // owner's own authenticated session (cookies shared between ownerPage's
  // browser context and ownerContext.request -- the same CSRF handshake a
  // real external runtime would need against this route).
  const allRuns = [...gate2PresenceFixture.publicAgents, gate2PresenceFixture.privateAgent];
  const triggerRun = async (agent: (typeof allRuns)[number]) => {
    const capabilityToken = mountTokens[agent.runId];
    if (!capabilityToken) {
      throw new Error(
        `GATE2_MOUNT_TOKENS has no entry for ${agent.runId} -- re-copy the export line ` +
          "from the most recent setup-gate2.ts run.",
      );
    }
    const frameElementId = gate2PresenceFixture.contexts.find(
      (c) => c.contextId === agent.contextId,
    )!.frameElementId;
    const post = (headers: Record<string, string>) =>
      ownerContext.request.post(
        `${API_URL}/drawings/${drawingId}/agent/mounts/${agent.runId}/tools/readFrame`,
        {
          headers: { "x-agent-mount-token": capabilityToken, ...headers },
          data: { frameElementId },
        },
      );
    let response = await post(await getCsrfHeaders(ownerContext.request));
    if (!response.ok() && response.status() === 403) {
      // Mirrors authLifecycle.ts's postJson: the cached CSRF token can go
      // stale between the many calls this loop makes -- refetch once and
      // retry rather than treating that as a real failure.
      const csrfRes = await ownerContext.request.get(`${API_URL}/csrf-token`);
      const csrf = (await csrfRes.json()) as { token: string; header?: string };
      response = await post({ [csrf.header || "x-csrf-token"]: csrf.token });
    }
    if (!response.ok()) {
      throw new Error(
        `Focus trigger for ${agent.runId} failed: HTTP ${response.status()} ${await response.text()}`,
      );
    }
  };
  const triggerOnce = async () => {
    for (const agent of allRuns) {
      await triggerRun(agent);
    }
  };

  let stopTriggering = false;
  const triggerLoop = (async () => {
    while (!stopTriggering) {
      await triggerOnce();
      await new Promise((resolve) => setTimeout(resolve, TRIGGER_INTERVAL_MS));
    }
  })();

  // Six screenshots at the fixture's sample seconds, from the OWNER's view
  // -- Davi answers from his own eyes on his own screen, live; these are
  // the retained record of what the board showed at each sample, not a
  // substitute for his answer.
  for (const sample of gate2PresenceFixture.samples) {
    const elapsedMs = Date.now() - startedAt;
    const waitMs = sample.atSecond * 1000 - elapsedMs;
    if (waitMs > 0) await ownerPage.waitForTimeout(waitMs);
    await ownerPage.screenshot({
      path: path.join(OUT_DIR, `sample-${String(sample.atSecond).padStart(2, "0")}s.png`),
    });
  }

  // Give the socket a little more room after the last sample before
  // stopping the trigger loop and closing.
  await observerPage.waitForTimeout(RECORDING_TAIL_MS);
  stopTriggering = true;
  await triggerLoop;

  fs.writeFileSync(
    path.join(OUT_DIR, "observer-capture.json"),
    JSON.stringify(
      {
        privateEventNames: gate2PresenceFixture.privateEventNames,
        ownerCaptured,
        observerCaptured,
      },
      null,
      2,
    ),
  );

  console.log(
    `Owner's own socket saw ${ownerCaptured.length} private-event frame(s); ` +
      `observer's saw ${observerCaptured.length}. Full log in observer-capture.json`,
  );
  console.log(`Screenshots and capture log are in ${OUT_DIR}`);

  // The positive control: if this is empty, the trigger loop above never
  // produced a live event either socket could have seen, and the negative
  // assertion below would be meaningless.
  expect(
    ownerCaptured.length,
    "Owner's own socket saw zero private-event frames -- the trigger loop " +
      "produced no observable live event, so the observer assertion below " +
      "would prove nothing.",
  ).toBeGreaterThan(0);

  // This assertion is the privacy signal Gate 2's own pass rule names --
  // not a judgment about the mapping answers, which only Davi gives.
  expect(observerCaptured, JSON.stringify(observerCaptured, null, 2)).toHaveLength(0);

  await ownerContext.close();
  await observerContext.close();
});
