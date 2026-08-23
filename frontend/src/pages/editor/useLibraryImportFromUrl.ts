import { useEffect } from "react";
import { toast } from "sonner";
import * as api from "../../api";
import type { UiCapability } from "../../integrations/excalidraw/capabilities";

type UseLibraryImportFromUrlParams = {
  /** The capability, not the handle: this hook has no business knowing the editor. */
  ui: UiCapability;
  isReady: boolean;
  user: unknown;
};

export const useLibraryImportFromUrl = ({ ui, isReady, user }: UseLibraryImportFromUrlParams) => {
  useEffect(() => {
    if (!isReady) return;
    const hash = window.location.hash;
    if (!hash.includes("addLibrary=")) return;
    const params = new URLSearchParams(hash.slice(1));
    const libraryUrl = params.get("addLibrary");
    if (!libraryUrl) return;
    const importLibraryFromUrl = async () => {
      try {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(libraryUrl, window.location.href);
        } catch {
          throw new Error("Invalid library URL");
        }
        if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
          throw new Error("Library URL must use http(s)");
        }
        const isLocalhost =
          parsedUrl.hostname === "localhost" ||
          parsedUrl.hostname === "127.0.0.1" ||
          parsedUrl.hostname === "::1";
        const isCrossOrigin = parsedUrl.origin !== window.location.origin;
        if (isCrossOrigin) {
          const ok = window.confirm(
            `Import library from external site?\n\n${parsedUrl.origin}\n\nOnly continue if you trust this source.`,
          );
          if (!ok) {
            toast.info("Library import canceled", { id: "library-import" });
            window.history.replaceState(
              null,
              "",
              window.location.pathname + window.location.search,
            );
            return;
          }
        }
        if (!import.meta.env.DEV && parsedUrl.protocol === "http:" && !isLocalhost) {
          throw new Error("Insecure http:// library URL is not allowed");
        }
        toast.loading("Importing library...", { id: "library-import" });
        const response = await fetch(parsedUrl.toString(), {
          credentials: "omit",
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch library: ${response.statusText}`);
        }
        const blob = await response.blob();
        if (blob.size > 10 * 1024 * 1024) {
          throw new Error("Library file is too large");
        }
        const imported = await ui.importLibrary(blob as never, { merge: true });
        // A refused import used to be impossible -- the raw call threw and the
        // catch below reported it. The capability answers instead of throwing,
        // so the failure has to be re-raised or the user is told "imported"
        // about a library that never arrived.
        if (!imported.ok) {
          throw new Error(`Library import was refused (${imported.code})`);
        }
        if (user) {
          await api.updateLibrary([...imported.value] as never);
        }
        toast.success("Library imported successfully", {
          id: "library-import",
        });
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch (err) {
        console.error("[Editor] Failed to import library:", err);
        toast.error("Failed to import library", { id: "library-import" });
      }
    };
    importLibraryFromUrl();
  }, [ui, isReady, user]);
};
