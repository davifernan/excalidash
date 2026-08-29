#!/usr/bin/env node
/**
 * Das "wurde dieser Head schon reviewt?"-Gate darf nur Hans' eigene, nicht-leere
 * Reviews zaehlen (NIL-688).
 *
 * Am 29.08.2026 hing PR #244 fest: alle Checks gruen, Zulassung gruen, und
 * trotzdem kein Review. Der Grund stand im uebersprungenen Schritt "Ask Multica
 * for a review". Das Gate davor zaehlte JEDES Review-Objekt auf der Head-SHA --
 * und GitHub legt eines mit leerem Body an, sobald jemand per Inline-Kommentar
 * auf einen Befund ANTWORTET.
 *
 * Damit blockierte die Antwort auf einen Befund das naechste Review, und zwar
 * genau im normalen Ablauf: Hans findet etwas, der Agent antwortet, Hans wird nie
 * wieder gefragt. Der PR sieht dabei gesund aus -- nichts ist rot, nichts laeuft,
 * es passiert nur nie wieder etwas.
 *
 * Dieser Test liest die Bedingung aus der Workflow-Datei und prueft sie gegen
 * die Faelle, die real aufgetreten sind.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const WORKFLOW = path.join(__dirname, "..", ".github/workflows/hans-friedrich.yml");
const HANS = "the-hans-friedrich[bot]";

/** Baut die Praedikatsfunktion aus dem Workflow nach -- bewusst als eigene
 *  Implementierung, damit der Test die ABSICHT prueft und nicht die Schreibweise. */
function alreadyReviewed(reviews, headSha) {
  return reviews.some(
    (r) =>
      r.commit_id === headSha &&
      r.user?.login === HANS &&
      (r.body ?? "").trim().length > 0,
  );
}

test("eine Agenten-Antwort auf einen Befund blockiert das naechste Review nicht", () => {
  // Genau die Lage von #244: Hans hat den Vorgaenger reviewt, der Agent hat
  // nachgebessert und per Inline-Kommentar geantwortet.
  const reviews = [
    { commit_id: "old", user: { login: HANS }, body: "## Review\n\n1 Korrektheit" },
    { commit_id: "head", user: { login: "davifernan" }, body: "" },
    { commit_id: "head", user: { login: "davifernan" }, body: "" },
  ];
  assert.strictEqual(alreadyReviewed(reviews, "head"), false);
});

test("ein echtes Hans-Review auf dem Head blockiert ein zweites", () => {
  const reviews = [{ commit_id: "head", user: { login: HANS }, body: "**Keine Befunde.**" }];
  assert.strictEqual(alreadyReviewed(reviews, "head"), true);
});

test("ein leeres Review zaehlt auch von Hans nicht -- es hat nichts gesagt", () => {
  const reviews = [{ commit_id: "head", user: { login: HANS }, body: "   " }];
  assert.strictEqual(alreadyReviewed(reviews, "head"), false);
});

test("ein Hans-Review auf einer anderen SHA blockiert diesen Head nicht", () => {
  const reviews = [{ commit_id: "other", user: { login: HANS }, body: "**Keine Befunde.**" }];
  assert.strictEqual(alreadyReviewed(reviews, "head"), false);
});

test("die Workflow-Datei prueft wirklich auf Autor und nicht-leeren Text", () => {
  const yaml = fs.readFileSync(WORKFLOW, "utf8");
  const start = yaml.indexOf("const already = reviews.some(");
  assert.notStrictEqual(start, -1, "Gate-Bedingung nicht gefunden");
  const block = yaml.slice(start, start + 400);
  assert.ok(
    block.includes("review.user?.login") && block.includes(HANS),
    "Das Gate muss auf Hans als Autor filtern, sonst zaehlen fremde Review-Objekte mit",
  );
  assert.ok(
    /review\.body\s*\?\?\s*""\)\.trim\(\)\.length\s*>\s*0/.test(block),
    "Das Gate muss leere Review-Koerper ausschliessen",
  );
});
