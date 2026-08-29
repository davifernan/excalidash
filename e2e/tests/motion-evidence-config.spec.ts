import { expect, test } from "@playwright/test";

test("resolved project video mode closes without motion evidence", ({}, testInfo) => {
  const motionEnabled = process.env.PLAYWRIGHT_MOTION_EVIDENCE === "true";
  const isMotionProject = testInfo.project.name === "motion-evidence";

  if (!motionEnabled) expect(isMotionProject).toBe(false);
  expect(testInfo.project.use.video).toBe(isMotionProject ? "on" : "retain-on-failure");
});
