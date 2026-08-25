import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

/**
 * NIL-376: the hamburger carries the board name and the way back (the old
 * floating island is gone), Help is its last entry and Excalidraw's floating
 * "?" is hidden, the top-right cluster reads as one control group, and the
 * laser pointer has exactly one control, visible whether or not anyone else
 * is on the board.
 */

const openMenu = async (page: Page) => {
  await page.getByTestId("main-menu-trigger").click();
};

test.describe("the hamburger carries the board's identity and the way back", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-chrome-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("the board name is the first line, editable, and there is no floating island", async ({
    page,
  }) => {
    const drawing = await getDrawing(api, drawingId);
    await openEditor(page, drawingId);

    // The island this package removed used to live here, always visible.
    await expect(page.getByTestId("editor-top-left")).toHaveCount(0);

    await openMenu(page);
    const menuItems = page.locator('[data-testid="dropdown-menu"] .dropdown-menu-container > *');
    await expect(page.getByTestId("menu-board-name")).toBeVisible();
    await expect(page.getByTestId("menu-board-name")).toContainText(drawing.name);
    // The first item wraps our content in Excalidraw's own ItemCustom
    // container, so check containment rather than the testid directly.
    await expect(menuItems.first().getByTestId("menu-board-name")).toHaveCount(1);

    const boardNameStyle = await page.getByTestId("menu-board-name").evaluate((element) => {
      const style = getComputedStyle(element);
      return { borderStyle: style.borderStyle, backgroundColor: style.backgroundColor };
    });
    expect(boardNameStyle.borderStyle).toBe("solid");
    expect(boardNameStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    const boardNameText = await page
      .getByTestId("menu-board-name")
      .locator(".board-name-menu-entry__value")
      .boundingBox();
    const backText = await page.getByTestId("menu-back-to-dashboard").evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (node.textContent?.trim() === "Back to dashboard") {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getBoundingClientRect().toJSON();
        }
      }
      return null;
    });
    expect(boardNameText).not.toBeNull();
    expect(backText).not.toBeNull();
    expect(boardNameText!.x).toBeCloseTo(backText!.x, 0);

    await page.getByTestId("menu-board-name").click();
    const nameInput = page.getByLabel("Drawing name");
    await nameInput.fill("Renamed via menu");
    await nameInput.press("Enter");

    await expect.poll(async () => (await getDrawing(api, drawingId)).name).toBe("Renamed via menu");
  });

  test("back to dashboard comes after the board name and returns to the drawings list", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    await openMenu(page);

    // Relative order, not a fixed index: the lead-in is a registry (see
    // chromeSlots.tsx's own comment) -- a later package's entry sliding in
    // between board-name and back-to-dashboard (workspace-context,
    // NIL-323/NIL-344) is a legitimate insertion, not a regression, and
    // must not fail this test.
    const boardNameBox = await page.getByTestId("menu-board-name").boundingBox();
    const backToDashboardBox = await page.getByTestId("menu-back-to-dashboard").boundingBox();
    expect(boardNameBox).not.toBeNull();
    expect(backToDashboardBox).not.toBeNull();
    expect(boardNameBox!.y).toBeLessThan(backToDashboardBox!.y);

    await page.getByTestId("menu-back-to-dashboard").click();
    await page.waitForURL("/collections");
    await expect(page.getByPlaceholder("Search drawings...")).toBeVisible();
  });

  test("Help is the last entry, and the floating question mark is gone", async ({ page }) => {
    await openEditor(page, drawingId);

    // Excalidraw's own floating help button, independent of the menu -- still
    // in the DOM (Excalidraw renders it unconditionally), hidden by CSS.
    await expect(page.locator(".help-icon")).toBeHidden();

    await openMenu(page);
    const menuItems = page.locator('[data-testid="dropdown-menu"] .dropdown-menu-container > *');
    await expect(menuItems.last()).toContainText("Help");
  });

  test("the hamburger starts on the same row as the tool bar", async ({ page }) => {
    await openEditor(page, drawingId);
    const hamburger = await page.getByTestId("main-menu-trigger").boundingBox();
    const toolbar = await page.locator(".App-toolbar").boundingBox();
    expect(hamburger).not.toBeNull();
    expect(toolbar).not.toBeNull();
    expect(hamburger!.y).toBeCloseTo(toolbar!.y, 0);
  });

  // NIL-579 finding 1 (Hans-Friedrich review, PR #147): the ticket's mandate
  // named the hamburger explicitly ("Leiste oben rechts, Timer, Hamburger --
  // faellt auf ein zurueckgenommenes Grau zurueck"), not just the top-right
  // bar. This pins the recessed treatment at the actual DOM/CSS seam: no
  // box-shadow ring, and a lower-contrast icon than the main toolbar's own.
  test("the hamburger trigger carries the same recessed treatment as the top-right bar", async ({
    page,
  }) => {
    await openEditor(page, drawingId);

    const trigger = page.getByTestId("main-menu-trigger");
    const style = await trigger.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { boxShadow: computed.boxShadow, backgroundColor: computed.backgroundColor };
    });
    expect(style.boxShadow).toBe("none");
    expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    const iconColor = await trigger
      .locator("svg")
      .first()
      .evaluate((element) => getComputedStyle(element).color);
    // `data-testid="toolbar-selection"` sits on the (childless) <input>, not
    // its wrapping <label> -- the icon <svg> is a sibling under
    // `.ToolIcon__icon`, not a descendant of the input, so the selector has
    // to anchor on the label via `:has()` rather than the testid element
    // itself (confirmed against the live DOM, NIL-579 fix-round).
    const toolbarIconColor = await page
      .locator('.App-toolbar label:has([data-testid="toolbar-selection"]) svg')
      .first()
      .evaluate((element) => getComputedStyle(element).color);
    expect(iconColor).not.toBe(toolbarIconColor);
  });
});

test.describe("the top-right control group reads as one bar", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-chrome-topright-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("the shared bar hugs its controls and an empty wrapper paints nothing", async ({ page }) => {
    await openEditor(page, drawingId);

    const wrapper = page.locator(".layer-ui__wrapper__top-right");
    const wrapperBg = await wrapper.evaluate((el) => getComputedStyle(el).backgroundColor);
    const libraryBg = await page
      .locator(".layer-ui__wrapper__top-right .sidebar-trigger.default-sidebar-trigger")
      .evaluate((el) => getComputedStyle(el).backgroundColor);

    expect(wrapperBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(libraryBg).toBe("rgba(0, 0, 0, 0)");

    const wrapperBox = (await wrapper.boundingBox())!;
    const contentBounds = await wrapper.evaluate((element) => {
      const boxes = [...element.children].map((child) => child.getBoundingClientRect());
      return {
        left: Math.min(...boxes.map((box) => box.left)),
        right: Math.max(...boxes.map((box) => box.right)),
      };
    });
    expect(wrapperBox.width - (contentBounds.right - contentBounds.left)).toBeLessThanOrEqual(10);

    // Excalidraw owns the wrapper. Removing its optional children models the
    // empty state at the actual DOM/CSS seam rather than re-testing the slot
    // registry's return value.
    await wrapper.evaluate((element) => element.replaceChildren());
    await expect(wrapper).toBeHidden();
  });

  // NIL-579: "height at the main toolbar" is a measured claim, not a guess --
  // this pins the wrapper's height to the live `.App-toolbar` island's height
  // so a future edit to either one that breaks the match fails loudly here,
  // rather than only being caught by eye.
  test("the bar's height matches the main toolbar's measured height", async ({ page }) => {
    await openEditor(page, drawingId);

    const wrapperBox = (await page.locator(".layer-ui__wrapper__top-right").boundingBox())!;
    const toolbarBox = (await page
      .locator(".App-toolbar-container .Island.App-toolbar")
      .boundingBox())!;
    expect(wrapperBox.height).toBeCloseTo(toolbarBox.height, 0);
  });

  // NIL-579: the Library trigger (Excalidraw's own markup) and our own
  // header-control buttons sit in the same bar but come from two different
  // stylesheets -- this is the seam where a baseline mismatch actually
  // originates (Davi's follow-up comment on NIL-579). Comparing the icons'
  // vertical centers, not the buttons' own box heights, is what catches a
  // regression here: the buttons can carry different heights and still read
  // as misaligned only once their icons don't line up.
  test("the Library trigger's icon lines up on the same baseline as our own header-control icons", async ({
    page,
  }) => {
    await openEditor(page, drawingId);

    const libraryIcon = (await page
      .locator(".layer-ui__wrapper__top-right .sidebar-trigger.default-sidebar-trigger svg")
      .first()
      .boundingBox())!;
    const shareIcon = (await page
      .locator('[data-testid="editor-share"] svg')
      .first()
      .boundingBox())!;

    const libraryCenter = libraryIcon.y + libraryIcon.height / 2;
    const shareCenter = shareIcon.y + shareIcon.height / 2;
    expect(Math.abs(libraryCenter - shareCenter)).toBeLessThanOrEqual(1);
  });

  // NIL-579's own Nachweispflicht: prove the presence zone and its hairline
  // divider occupy zero width without peers, as a measured width -- not a
  // visibility flag -- and that the bar returns to that exact width once a
  // peer who made the zone non-empty leaves again (no leftover flex `gap`,
  // the same class of bug NIL-564 fixed for the outer wrapper).
  test("the presence zone and its hairline take zero width without peers, and give it back when a peer leaves", async ({
    page,
    browser,
  }) => {
    await openEditor(page, drawingId);

    const wrapper = page.locator(".layer-ui__wrapper__top-right");
    await expect(page.locator('[data-testid="editor-zone-divider"]')).toHaveCount(0);
    const aloneBox = (await wrapper.boundingBox())!;

    const peerContext = await browser.newContext();
    const peerPage = await peerContext.newPage();
    try {
      await peerPage.goto(`/editor/${drawingId}`);
      await peerPage.waitForSelector("canvas", { timeout: 15000 });

      await expect(page.locator('[data-testid="editor-zone-divider"]')).toHaveCount(1);
      const withPeerBox = (await wrapper.boundingBox())!;
      expect(withPeerBox.width).toBeGreaterThan(aloneBox.width);
    } finally {
      await peerContext.close();
    }

    await expect(page.locator('[data-testid="editor-zone-divider"]')).toHaveCount(0, {
      timeout: 15000,
    });
    const afterLeaveBox = (await wrapper.boundingBox())!;
    expect(afterLeaveBox.width).toBeCloseTo(aloneBox.width, 0);
  });
});

test.describe("the laser pointer -- one toolbar control, present alone (NIL-374)", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-chrome-laser-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("the toggle follows Sticky Note inside the toolbar, and the flyout duplicate is hidden", async ({
    page,
  }) => {
    await openEditor(page, drawingId);

    const laser = page.locator('.App-toolbar [data-testid="toolbar-LaserPointer"]');
    const nativeLaserIsland = page.locator(
      '.App-toolbar-container > .Island:not(.App-toolbar):has([data-testid="toolbar-LaserPointer"])',
    );
    await expect(laser).toBeVisible();
    await expect(nativeLaserIsland).toHaveCount(1);
    await expect(nativeLaserIsland).toBeHidden();

    const toolbarBox = (await page.locator(".App-toolbar").boundingBox())!;
    const stickyBox = (await page.getByTestId("toolbar-sticky").boundingBox())!;
    const laserBox = (await laser.locator("..").boundingBox())!;
    expect(laserBox.x).toBeGreaterThanOrEqual(stickyBox.x + stickyBox.width - 1);
    expect(laserBox.x + laserBox.width).toBeLessThanOrEqual(toolbarBox.x + toolbarBox.width + 1);
    expect(laserBox.y).toBeGreaterThanOrEqual(toolbarBox.y - 1);
    expect(laserBox.y + laserBox.height).toBeLessThanOrEqual(toolbarBox.y + toolbarBox.height + 1);

    await page.locator(".App-toolbar__extra-tools-trigger").click();
    await expect(page.getByTestId("toolbar-laser")).toHaveCount(1);
    await expect(page.getByTestId("toolbar-laser")).toBeHidden();
    await page.keyboard.press("Escape");
  });

  test("carries the K hint, and arms the laser tool", async ({ page }) => {
    await openEditor(page, drawingId);

    const laser = page.locator('.App-toolbar [data-testid="toolbar-LaserPointer"]');
    const hint = await laser
      .locator("..")
      .evaluate((el) => getComputedStyle(el, "::after").content);
    expect(hint).toBe('"K"');

    // The checkbox itself sits under its own icon in paint order (Excalidraw's
    // usual custom-checkbox styling); the label is the real click surface.
    await laser.locator("..").click();
    await page.waitForFunction(
      () =>
        (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__.getAppState()
          .activeTool?.name === "laser",
    );
  });
});
