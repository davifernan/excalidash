/**
 * The editor's stylesheet.
 *
 * Imported here rather than in main.tsx so the application entry point does not
 * name the package at all, and so the one import that is a side effect rather
 * than a value sits with everything else this layer owns.
 */
import "@excalidraw/excalidraw/index.css";
import "./stacking.css";
