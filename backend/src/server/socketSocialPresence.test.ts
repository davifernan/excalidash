import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The live socket paths, guarded at the source.
 *
 * A local review of the first version of this work found five handlers that
 * read a presence directly and put its name and colour on other people's
 * screens -- cursor-move, live selection-update, follow, invite-here and
 * presenter. The registry projections excluded automations; these did not, and
 * an API key carries its owner's name, so an automation appeared as a person
 * on the very surfaces that matter most.
 *
 * A behavioural test per handler would prove today's five and say nothing about
 * the sixth somebody adds. This asserts the wiring instead: every module that
 * acts socially receives `getSocialPresence`, which returns nothing for an
 * automation, so each handler's existing `if (!presence) return;` closes the
 * path without a new branch.
 *
 * Add a social module and wire it to the raw `getPresence`, and this fails with
 * the module named.
 */
const socketSource = fs.readFileSync(path.join(__dirname, "socket.ts"), "utf8");

/** Modules whose emissions carry a person's name, colour, or headcount. */
const SOCIAL_MODULES = [
  "createSocketFollowManager",
  "createSocketInviteHereManager",
  "createSocketPresenterManager",
  "registerCoreRoomEvents",
] as const;

/**
 * Deliberately NOT social: holding a document edit lock is work, not a social
 * act, and an agent editing a document has to be able to. Listed rather than
 * omitted so the exception is a decision on the record, not an oversight.
 */
const DELIBERATELY_UNGATED = ["registerDocumentEditLockRoomEvent"] as const;

const wiringOf = (moduleName: string): string => {
  // The call site, not the import line: searching for the bare name finds the
  // import first, and the first version of this test asserted against that.
  const start = socketSource.indexOf(`${moduleName}({`);
  expect(start, `${moduleName} is not called in socket.ts at all`).toBeGreaterThan(-1);
  const open = socketSource.indexOf("{", start);
  const close = socketSource.indexOf("});", open);
  return socketSource.slice(open, close);
};

describe("live socket paths do not let an automation act as a person", () => {
  it.each(SOCIAL_MODULES)("wires %s through getSocialPresence", (moduleName) => {
    const wiring = wiringOf(moduleName);
    expect(wiring, `${moduleName} reads presence without the social gate`).toContain(
      "getPresence: getSocialPresence",
    );
  });

  it.each(DELIBERATELY_UNGATED)("leaves %s on the raw accessor on purpose", (moduleName) => {
    const wiring = wiringOf(moduleName);
    expect(wiring).not.toContain("getSocialPresence");
  });

  it("keeps the social accessor defined in terms of the actor, not a name list", () => {
    // If this ever stops reading `actor`, the four assertions above still pass
    // while guarding nothing -- they only check which accessor is passed.
    expect(socketSource).toMatch(
      /const getSocialPresence[\s\S]{0,400}presence\?\.actor === "human"/,
    );
  });
});
