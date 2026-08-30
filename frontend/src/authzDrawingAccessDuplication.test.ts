import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural counterprobe for the `DrawingAccess`/`DrawingPermission`
 * extraction (NIL-637, comments/authz domain, slice 6).
 *
 * Unlike the socket-event slices before this one, there is no runtime wire
 * message to drive both sides against -- `DrawingAccess`/`DrawingPermission`
 * are pure string-literal-union types, and the four capability predicates
 * (`canViewDrawing`, `canCommentDrawing`, `canEditDrawing`, `isOwnerAccess`)
 * are now imported and called directly by both runtimes rather than each
 * independently re-declaring the check -- so there is no second
 * implementation left to disagree with the first. Before this slice there
 * were 20 occurrences across 9 frontend files (`ShareModal.tsx`,
 * `GeneralAccessSection.tsx`, `SharePeopleSection.tsx`, `Editor.tsx`,
 * `useEditorSceneLoader.ts`, `chromeSlots.tsx`, `EditorView.tsx`,
 * `types/index.ts`, `useCommentsFeature.tsx`, `api/search.ts`,
 * `api/drawings.ts`) of the same four-or-five-member literal union,
 * hand-typed instead of imported -- exactly the shape of NIL-624's
 * pagination regression (a comment asserting two independent declarations
 * "must match" is not evidence they do).
 *
 * The proof this slice needs is therefore structural, not behavioral: does
 * any frontend file still hand-declare this alphabet instead of importing
 * `DrawingAccess`/`DrawingPermission` from `@excalidash/domain/authz`? This
 * test scans the real `frontend/src` tree (not a copy, not a fixture) and
 * fails the moment one does -- which is also its own red-proof: temporarily
 * copying one of the removed literals back into a real file (see the PR
 * HANDOFF for the exact mutation) turns this test red, and only this test,
 * while every other suite stays green.
 */

// This file lives at frontend/src/authzDrawingAccessDuplication.test.ts, so
// __dirname already IS frontend/src -- no ".." (that would resolve to
// frontend/ and additionally walk frontend/public, frontend/scripts, and
// any local frontend/node_modules or dist that later exists, none of which
// this guard is about).
const FRONTEND_SRC = __dirname;

const DRAWING_ACCESS_LITERAL = /"none"\s*\|\s*"view"\s*\|\s*"comment"\s*\|\s*"edit"\s*\|\s*"owner"/;
const DRAWING_ACCESS_NO_NONE_LITERAL = /"view"\s*\|\s*"comment"\s*\|\s*"edit"\s*\|\s*"owner"/;
const DRAWING_PERMISSION_LITERAL = /"view"\s*\|\s*"comment"\s*\|\s*"edit"(?!\s*\|\s*"owner")/;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
};

describe("DrawingAccess/DrawingPermission duplication guard", () => {
  it("no frontend file hand-declares the drawing access alphabet instead of importing it", () => {
    const offenders: string[] = [];
    for (const file of walk(FRONTEND_SRC)) {
      const content = fs.readFileSync(file, "utf8");
      if (
        DRAWING_ACCESS_LITERAL.test(content) ||
        DRAWING_ACCESS_NO_NONE_LITERAL.test(content) ||
        DRAWING_PERMISSION_LITERAL.test(content)
      ) {
        offenders.push(path.relative(FRONTEND_SRC, file));
      }
    }
    expect(offenders, "files re-declaring the DrawingAccess/DrawingPermission alphabet").toEqual(
      [],
    );
  });
});
