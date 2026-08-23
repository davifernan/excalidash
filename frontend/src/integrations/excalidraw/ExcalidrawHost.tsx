import React from "react";
import { Excalidraw } from "@excalidraw/excalidraw";

import { reportFailure } from "./compatibility/diagnostics";
import { fail } from "./errors";
import { packageVersion } from "./version";

/**
 * The one place this application mounts Excalidraw.
 *
 * Wrapping rather than adding: there is exactly one mount point before and
 * after. A second live host would mean two editors racing for the same board,
 * which is worse than the seam it was meant to close.
 *
 * The props are passed through untouched on purpose. This commit changes where
 * the editor is mounted from, not how it behaves; the capabilities that will
 * replace these props arrive with the consumer migration. Anything clever here
 * would make it impossible to tell a later behaviour change from this one.
 */

type ExcalidrawHostProps = React.ComponentProps<typeof Excalidraw>;

/**
 * A crash inside the editor costs the canvas, not the application.
 *
 * Without it the nearest net is the one around the whole route tree, which
 * takes the dashboard, the dialogs and the way back with it. This boundary is
 * also the only place where a failure in the editor is loud: everything else in
 * this layer returns a result, and a returned failure nobody subscribed to is
 * silent by construction.
 */
class HostBoundary extends React.Component<{ children: React.ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: Error) {
    reportFailure(fail("editor-changed", "host.render", { detail: error.name }), packageVersion());
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div
        role="alert"
        className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white px-6 text-center dark:bg-neutral-950"
      >
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">The canvas stopped</h2>
        <p className="max-w-sm text-sm text-gray-600 dark:text-gray-400">
          Your board is saved. Reloading the page usually brings the canvas back.
        </p>
      </div>
    );
  }
}

export const ExcalidrawHost: React.FC<ExcalidrawHostProps> = ({ children, ...props }) => (
  <HostBoundary>
    <Excalidraw {...props}>{children}</Excalidraw>
  </HostBoundary>
);
