import { expect, test } from "@playwright/test";

test("motion evidence project retains successful video", ({}, testInfo) => {
  expect(testInfo.project.name).toBe("motion-evidence");
  expect(testInfo.project.use.video).toBe("on");
});
