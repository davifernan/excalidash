/**
 * The editor's own UI slots, re-exported under local names.
 *
 * These are children components rather than props: Excalidraw reads its own
 * subtree to find them. So they cannot be wrapped away -- putting a component of
 * ours in between would leave the editor finding nothing and rendering neither
 * the footer nor the menu.
 *
 * Re-exported anyway, for the same reason as the element utilities: this is the
 * one file that names them, so an upgrade that renames one breaks here and
 * verifySeams can say so, rather than the footer quietly not appearing.
 */

import { Footer, MainMenu } from "@excalidraw/excalidraw";

/** The strip along the bottom of the canvas. */
export const EditorFooter = Footer;

/** The hamburger menu, with the editor's own default entries available on it. */
export const EditorMenu = MainMenu;
