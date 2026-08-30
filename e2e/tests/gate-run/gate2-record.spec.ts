import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";
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
 *     foreign observer and inspects raw WebSocket frames for the four
 *     `privateEventNames` -- this is the actual Gate 2 privacy signal, not
 *     a stand-in for it.
 *  3. Takes six screenshots of the owner's view at the fixture's sample
 *     seconds (0/5/10/15/20/25) without prompting Davi or reading his
 *     answers -- the screenshots are the retained artifact, not the
 *     measurement.
 *
 * Requires env vars: GATE_OWNER_EMAIL, GATE_OWNER_PASSWORD,
 * GATE_OBSERVER_EMAIL, GATE_OBSERVER_PASSWORD (an existing second account
 * with no other relationship to this drawing -- grantDrawingPermission
 * below gives it exactly "view").
 *
 * Command: npx playwright test gate-run/gate2-record.spec.ts --project=chromium
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

test("records the observer's private-event capture and six timestamped board screenshots", async ({
  browser,
}) => {
  test.setTimeout(60_000);
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
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as { boardUrl: string };
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Grant the observer plain view access, and nothing more, using the
  // owner's own authenticated context -- the same grant a real teammate
  // would receive, not a privileged test shortcut.
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await loginViaUi(ownerPage, { email: ownerEmail, password: ownerPassword });
  const drawingId = state.boardUrl.split("/").pop()!;

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
  await ownerPage.goto(state.boardUrl);

  // The foreign observer: a second, independently authenticated browser
  // context (its own cookies, its own socket connection).
  const observerContext = await browser.newContext();
  const observerPage = await observerContext.newPage();
  await loginViaUi(observerPage, { email: observerEmail, password: observerPassword });

  const captured: { atMs: number; eventName: string; frame: string }[] = [];
  const startedAt = Date.now();
  observerPage.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      const payload = typeof frame.payload === "string" ? frame.payload : "";
      for (const eventName of gate2PresenceFixture.privateEventNames) {
        if (payload.includes(eventName)) {
          captured.push({ atMs: Date.now() - startedAt, eventName, frame: payload });
        }
      }
    });
  });
  await observerPage.goto(state.boardUrl);

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

  // Give the socket a little more room after the last sample before closing.
  await observerPage.waitForTimeout(2_000);

  fs.writeFileSync(
    path.join(OUT_DIR, "observer-capture.json"),
    JSON.stringify(
      { privateEventNames: gate2PresenceFixture.privateEventNames, captured },
      null,
      2,
    ),
  );

  console.log(`Wrote ${captured.length} captured private-event frame(s) to observer-capture.json`);
  console.log(`Screenshots and capture log are in ${OUT_DIR}`);

  // This assertion is the privacy signal Gate 2's own pass rule names --
  // not a judgment about the mapping answers, which only Davi gives.
  expect(captured, JSON.stringify(captured, null, 2)).toHaveLength(0);

  await ownerContext.close();
  await observerContext.close();
});
