"use strict";

function videoModeForProject(projectName, motionEvidence) {
  return projectName === "motion-evidence" && motionEvidence ? "on" : "retain-on-failure";
}

module.exports = { videoModeForProject };
