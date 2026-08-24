import { test, expect, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

/**
 * The presenter contract's whole point is that a room converges around one
 * authoritative view. A test that only watches the presenter's own screen
 * would miss the thing that actually matters: does the audience see it too,
 * and does the audience keep control of whether it follows.
 */

const insertBrainstormingTemplate = async (page: Page) => {
  await page.getByTestId("main-menu-trigger").click();
  await page.getByText("Insert: Brainstorming").click();
  // Menu closes itself on select; nothing else to wait for here.
};

/**
 * "Present" is MainMenu-only, not a HeaderControlSlotEntry: a third header
 * icon alongside invite/share pushed `.layer-ui__wrapper__top-right` past
 * the width Excalidraw's own collaborator-avatar list uses before
 * collapsing to a "+N" badge (chromeSlots.tsx's own regression note, first
 * measured for the "comments" entry, reproduced here for this one).
 */
const clickPresentMenuItem = async (page: Page) => {
  await page.getByTestId("main-menu-trigger").click();
  await page.getByTestId("menu-present").click();
};

const openPresenterPanel = (page: Page) => page.getByTestId("presentation-overlay-presenter");
const openAudienceBanner = (page: Page) => page.getByTestId("presentation-overlay-audience");

test.describe("presenting converges the room", () => {
  test("audience sees the frame the presenter jumps to, and can stop following", async ({
    browser,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: "Presenter E2E" });

    const presenterContext = await browser.newContext();
    const presenterPage = await presenterContext.newPage();
    await openEditor(presenterPage, drawing.id, { settleMs: 1000 });

    const audienceContext = await browser.newContext();
    const audiencePage = await audienceContext.newPage();
    await openEditor(audiencePage, drawing.id, { settleMs: 1000 });

    await insertBrainstormingTemplate(presenterPage);
    await presenterPage.waitForTimeout(300);

    await clickPresentMenuItem(presenterPage);
    await expect(openPresenterPanel(presenterPage)).toBeVisible();
    await expect(openAudienceBanner(audiencePage)).toBeVisible({ timeout: 8000 });
    await expect(openAudienceBanner(audiencePage)).toContainText("is presenting");

    const firstFrame = openPresenterPanel(presenterPage)
      .getByTestId("presentation-frame-entry")
      .first();
    await expect(firstFrame).toContainText("1. Ideas");
    await firstFrame.click();

    // The audience's own banner names the frame the presenter just jumped
    // to -- the observable proof that the broadcast, not just the presenter's
    // own screen, moved.
    await expect(openAudienceBanner(audiencePage)).toContainText("1. Ideas", { timeout: 8000 });

    // Stop following: a deliberate, local decision that must not touch the
    // presenter's side at all.
    await audiencePage.getByTestId("presentation-follow-toggle").click();
    await expect(audiencePage.getByTestId("presentation-follow-toggle")).toContainText(
      "Not following",
    );
    await expect(openPresenterPanel(presenterPage)).toBeVisible();

    await presenterPage.getByTestId("presentation-stop").click();
    await expect(openPresenterPanel(presenterPage)).toHaveCount(0);
    await expect(openAudienceBanner(audiencePage)).toHaveCount(0, { timeout: 8000 });

    await presenterContext.close();
    await audienceContext.close();
    await deleteDrawing(request, drawing.id);
  });

  test("a second editor cannot start presenting while one is already presenting", async ({
    browser,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: "Presenter Conflict E2E" });

    const firstContext = await browser.newContext();
    const firstPage = await firstContext.newPage();
    await openEditor(firstPage, drawing.id, { settleMs: 1000 });

    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await openEditor(secondPage, drawing.id, { settleMs: 1000 });

    await clickPresentMenuItem(firstPage);
    await expect(openPresenterPanel(firstPage)).toBeVisible();
    await expect(openAudienceBanner(secondPage)).toBeVisible({ timeout: 8000 });

    // The menu entry now reads "<name> is presenting" for the second editor,
    // but the testid is stable -- clicking it still sends `start`, which the
    // server rejects with presenter-active, and the audience banner (not a
    // presenter panel) keeps showing on their screen.
    await clickPresentMenuItem(secondPage);
    await secondPage.waitForTimeout(500);
    await expect(openPresenterPanel(secondPage)).toHaveCount(0);
    await expect(openAudienceBanner(secondPage)).toBeVisible();

    await firstContext.close();
    await secondContext.close();
    await deleteDrawing(request, drawing.id);
  });
});

test.describe("voting stays concealed until revealed", () => {
  test("no tally is visible to anyone before reveal, and it converges after", async ({
    browser,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: "Voting E2E" });

    const modContext = await browser.newContext();
    const modPage = await modContext.newPage();
    await openEditor(modPage, drawing.id, { settleMs: 1000 });

    const voterContext = await browser.newContext();
    const voterPage = await voterContext.newPage();
    await openEditor(voterPage, drawing.id, { settleMs: 1000 });

    await modPage.getByTestId("main-menu-trigger").click();
    await modPage.getByText("Start a vote").click();
    await modPage.getByTestId("voting-prompt-input").fill("Ship it?");
    const options = modPage.getByTestId("voting-option-input");
    await options.nth(0).fill("Yes");
    await options.nth(1).fill("No");
    await modPage.getByTestId("voting-open-submit").click();

    await expect(voterPage.getByTestId("voting-overlay")).toBeVisible({ timeout: 8000 });
    await expect(voterPage.getByTestId("voting-overlay")).toContainText("Ship it?");

    // Cast from both sides before reveal.
    await voterPage.getByTestId("voting-option").first().click();
    await voterPage.getByTestId("voting-cast-submit").click();
    await modPage.getByTestId("voting-option").first().click();
    await modPage.getByTestId("voting-cast-submit").click();

    // Neither screen shows a number anywhere in the voting panel while open --
    // the concealment this package's whole voting design exists to guarantee.
    await expect(modPage.getByTestId("voting-overlay")).not.toContainText(/\b[12]\b/);
    await expect(voterPage.getByTestId("voting-overlay")).not.toContainText(/\b[12]\b/);

    await modPage.getByTestId("voting-reveal").click();

    // Both sides converge on the same, server-computed result.
    await expect(modPage.getByTestId("voting-overlay")).toContainText("2 people voted", {
      timeout: 8000,
    });
    await expect(voterPage.getByTestId("voting-overlay")).toContainText("2 people voted", {
      timeout: 8000,
    });

    await modContext.close();
    await voterContext.close();
    await deleteDrawing(request, drawing.id);
  });
});
