/**
 * The Excalidraw version this build is running against.
 *
 * Injected at config time from the installed package rather than written down
 * here, so a diagnostic reports what is there and not what somebody remembered
 * to update. The canary run relies on it to say which version a seam broke on.
 */
export const packageVersion = (): string => import.meta.env.VITE_EXCALIDRAW_VERSION || "unknown";
