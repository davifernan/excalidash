/**
 * The editor's own languages, and the hook that reads its strings.
 *
 * A thin pass-through, in the layer for the same reason as the element
 * utilities: an upgrade that renames either should break one file, and
 * verifySeams should be able to name it.
 *
 * The list is exposed as a plain shape rather than the package's own, so the
 * language picker can be written against a code and a label without knowing
 * what else Excalidraw hangs off a language.
 */

import { languages, useI18n } from "@excalidraw/excalidraw";

export type EditorLanguage = { code: string; label: string };

export const editorLanguages: readonly EditorLanguage[] = (
  languages as readonly { code: string; label: string }[]
).map(({ code, label }) => ({ code, label }));

export const useEditorTranslations = useI18n;
