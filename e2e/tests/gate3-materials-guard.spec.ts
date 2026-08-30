import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import { gate3BoardThreadFixture } from "./fixtures/agentContextGateFixtures";

/**
 * NIL-701: `agent-context-gate-fixtures.spec.ts` guards the fixture itself,
 * not the materials an operator actually fills in -- and the two can drift
 * silently, as they did once already (the timer log template's session 2
 * rows repeated session 1's assignment instead of the fixture's crossed
 * `balancedOrder`, quietly erasing the counterbalance the whole comparison
 * depends on). This spec re-derives the expected (session, surface, taskId)
 * rows from `balancedOrder` itself and fails if the template's rows differ
 * in content or order -- so a future edit to either side is caught here,
 * not discovered by reading a filled-in table by eye.
 */

const TEMPLATE_PATH = path.resolve(
  __dirname,
  "gate-run",
  "materials",
  "gate3-timer-log-template.md",
);

type Row = { session: string; surface: string; taskId: string };

const parseTemplateRows = (markdown: string): Row[] =>
  markdown
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0),
    )
    // Drop the header row and the "---" separator row.
    .filter((cells) => cells[0] !== "Session" && !/^-+$/.test(cells[0] ?? ""))
    .map((cells) => ({ session: cells[0]!, surface: cells[1]!, taskId: cells[2]! }));

const expectedRows = (): Row[] =>
  gate3BoardThreadFixture.balancedOrder.flatMap((entry) => [
    ...entry.boardThreadTaskIds.map((taskId) => ({
      session: String(entry.session),
      surface: "board-thread",
      taskId,
    })),
    ...entry.terminalTaskIds.map((taskId) => ({
      session: String(entry.session),
      surface: "terminal-transcript",
      taskId,
    })),
  ]);

test("Gate 3's timer log template rows match balancedOrder exactly, in order", () => {
  const rows = parseTemplateRows(fs.readFileSync(TEMPLATE_PATH, "utf8"));
  expect(rows).toEqual(expectedRows());
});
