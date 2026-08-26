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

  test("passes through Excalidraw's command palette and canvas search while omitting duplicate collaboration actions", async ({
    page,
    browser,
  }) => {
    await openEditor(page, drawingId);

    // Keep a real peer connected so the old conditional Invite entry would
    // be present if it still existed. Checking without a peer only proves the
    // condition hid it, not that the duplicate route was removed.
    const peerContext = await browser.newContext();
    const peerPage = await peerContext.newPage();
    try {
      await openEditor(peerPage, drawingId);
      await expect(page.getByTestId("editor-invite")).toBeVisible();

      await openMenu(page);
      const menu = page.getByTestId("dropdown-menu");
      await expect(menu.getByText("Share", { exact: true })).toHaveCount(0);
      await expect(menu.getByText("Invite everyone here", { exact: true })).toHaveCount(0);
      await expect(page.getByTestId("command-palette-button")).toBeVisible();
      await expect(page.getByTestId("search-menu-button")).toBeVisible();

      await page.getByTestId("command-palette-button").click();
      const palette = page.locator(".command-palette-dialog");
      await expect(palette).toBeVisible();
      await palette.locator("input").fill("grid");
      await expect(palette.locator(".item-selected")).toContainText("Toggle grid");
      await page.keyboard.press("Enter");
      // The selected native command changes the board state and the rendered
      // grid; waiting for persistence proves this was the real Excalidraw
      // action, not a lookalike palette row that only closed the dialog.
      await expect
        .poll(async () => (await getDrawing(api, drawingId)).appState?.gridModeEnabled)
        .toBe(true);

      await openMenu(page);
      await page.getByTestId("search-menu-button").click();
      await expect(page.locator(".layer-ui__search")).toBeVisible();
    } finally {
      await peerContext.close();
    }
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

  test("Share and Invite expose visible hover tooltips in the top-right bar", async ({
    page,
    browser,
  }) => {
    await openEditor(page, drawingId);

    const shareTooltip = page.getByRole("tooltip", { name: "Share" });
    await expect(shareTooltip).toBeHidden();
    await page.getByTestId("editor-share").hover();
    await expect(shareTooltip).toBeVisible();
    const shareBox = await shareTooltip.boundingBox();
    expect(shareBox).not.toBeNull();
    expect(shareBox!.width).toBeGreaterThan(0);

    const peerContext = await browser.newContext();
    const peerPage = await peerContext.newPage();
    try {
      await openEditor(peerPage, drawingId);
      const invite = page.getByTestId("editor-invite");
      await expect(invite).toBeVisible();
      const inviteTooltip = page.getByRole("tooltip", { name: "Invite everyone here" });
      await expect(inviteTooltip).toBeHidden();
      await invite.hover();
      await expect(inviteTooltip).toBeVisible();
      const inviteBox = await inviteTooltip.boundingBox();
      expect(inviteBox).not.toBeNull();
      expect(inviteBox!.width).toBeGreaterThan(shareBox!.width);
    } finally {
      await peerContext.close();
    }
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

  // NIL-603: NIL-564's max-content bar was correct alone, but NIL-579's
  // four-slot UserList reservation made it jump by 191px when the first peer
  // arrived. Exercise every attendance state from the report against the
  // rendered Excalidraw avatar list: one directly clickable avatar stays
  // visible, overflow becomes +N, and neither the bar's width nor its 44px
  // toolbar-aligned height grows further.
  test("the bar stays hard-bounded with 0, 1, 2, 5, and 12 remote participants", async ({
    page,
    browser,
  }) => {
    // Twelve real editor contexts are intentional evidence, and a loaded CI
    // runner can take longer than the suite's ordinary one-page timeout to
    // bring them all through Vite and the collaboration handshake.
    test.setTimeout(120_000);
    await openEditor(page, drawingId);

    const peerContexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    const measurements: Array<{
      remoteCount: number;
      width: number;
      height: number;
      toolbarHeight: number;
      visibleAvatars: number;
      overflowText: string | null;
      circleOverlap: number | null;
    }> = [];
    const targetCounts = [0, 1, 2, 5, 12] as const;

    try {
      for (const remoteCount of targetCounts) {
        while (peerContexts.length < remoteCount) {
          const context = await browser.newContext();
          peerContexts.push(context);
          const peer = await context.newPage();
          await openEditor(peer, drawingId);
        }

        await expect
          .poll(async () => {
            const visible = await page.locator(".UserList__collaborator--avatar-only").count();
            const overflow = await page
              .locator(".UserList__more")
              .evaluateAll((elements) => elements[0]?.textContent ?? null);
            return visible + Number(overflow?.replace("+", "") || 0);
          })
          .toBe(remoteCount);

        const wrapper = (await page.locator(".layer-ui__wrapper__top-right").boundingBox())!;
        const toolbar = (await page
          .locator(".App-toolbar-container .Island.App-toolbar")
          .boundingBox())!;
        measurements.push({
          remoteCount,
          width: wrapper.width,
          height: wrapper.height,
          toolbarHeight: toolbar.height,
          visibleAvatars: await page.locator(".UserList__collaborator--avatar-only").count(),
          overflowText: await page
            .locator(".UserList__more")
            .evaluateAll((elements) => elements[0]?.textContent ?? null),
          circleOverlap: await page.locator(".UserList > *").evaluateAll((elements) => {
            if (elements.length !== 2) return null;
            const first = elements[0].getBoundingClientRect();
            const second = elements[1].getBoundingClientRect();
            return first.right - second.left;
          }),
        });
      }
    } finally {
      await Promise.all(peerContexts.map((context) => context.close()));
    }

    expect(measurements.map(({ remoteCount }) => remoteCount)).toEqual(targetCounts);
    for (const measurement of measurements) {
      expect(measurement.height).toBeCloseTo(measurement.toolbarHeight, 0);
    }

    const [alone, one, two, five, twelve] = measurements;
    expect(alone.visibleAvatars).toBe(0);
    expect(alone.overflowText).toBeNull();
    expect(one.visibleAvatars).toBe(1);
    expect(one.overflowText).toBeNull();
    expect(two.visibleAvatars).toBe(1);
    expect(two.overflowText).toBe("+1");
    expect(two.circleOverlap).toBeCloseTo(6, 0);
    expect(five.visibleAvatars).toBe(1);
    expect(five.overflowText).toBe("+4");
    expect(five.circleOverlap).toBeCloseTo(6, 0);
    expect(twelve.visibleAvatars).toBe(1);
    expect(twelve.overflowText).toBe("+11");
    expect(twelve.circleOverlap).toBeCloseTo(6, 0);

    // The no-peer actions-only state from NIL-564 is unchanged; after the
    // first peer adds the presence zone, attendance may not add another pixel.
    expect(one.width).toBeGreaterThan(alone.width);
    expect(one.width).toBeLessThanOrEqual(240);
    for (const crowded of [two, five, twelve]) {
      expect(crowded.width).toBeCloseTo(one.width, 0);
    }

    console.info("NIL-603 top-right measurements", measurements);
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

    // The hint lives in Excalidraw's own `.ToolIcon__keybinding` element --
    // the same one Sticky Note's "N" hint uses -- not a hand-built CSS
    // ::after badge (that badge is what produced Davi's "K is bold and
    // doesn't match" complaint in NIL-581). Anchor to that shared element
    // rather than to one button's rendered pixels, so a future redrawn
    // lookalike fails here instead of silently drifting.
    const laserHint = laser.locator("..").locator(".ToolIcon__keybinding");
    const stickyHint = page.getByTestId("toolbar-sticky").locator(".ToolIcon__keybinding");

    await expect(laserHint).toBeVisible();
    await expect(laserHint).toHaveText("K");
    expect(await laserHint.getAttribute("class")).toBe(await stickyHint.getAttribute("class"));

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
