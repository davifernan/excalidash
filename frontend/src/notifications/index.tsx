/* eslint-disable react-refresh/only-export-components -- the host and emitters intentionally share the sole Sonner boundary. */
import type { CSSProperties } from "react";
import { Toaster, toast } from "sonner";
import { stacking } from "../integrations/excalidraw/stacking";

export type NotificationSeverity = "error" | "warning" | "success" | "info" | "loading";

export type NotificationOptions = Readonly<{
  /** One operation keeps one place in the stack while its state changes. */
  key?: string;
  /** Supporting content such as a reference or upload percentage. */
  detail?: string;
}>;

export const NOTIFICATION_DURATION_MS: Readonly<Record<NotificationSeverity, number>> = {
  error: 8_000,
  warning: 7_000,
  info: 5_000,
  success: 4_000,
  loading: Number.POSITIVE_INFINITY,
};

const emitters = {
  error: toast.error,
  warning: toast.warning,
  success: toast.success,
  info: toast.info,
  loading: toast.loading,
} satisfies Record<NotificationSeverity, typeof toast.error>;

export const notify = (
  severity: NotificationSeverity,
  message: string,
  { key, detail }: NotificationOptions = {},
): string | number =>
  emitters[severity](message, {
    description: detail,
    duration: NOTIFICATION_DURATION_MS[severity],
    id: key,
  });

export type ExcalidrawToast = Readonly<{
  message: string;
  closable?: boolean;
  duration?: number;
}>;

/**
 * Excalidraw has one untyped notification lane. Preserve its replacement,
 * duration and close behavior while giving it an `info` severity in the one
 * application stack. Product callers use `notify`; only the upstream bridge
 * may supply these transport-level options.
 */
export const notifyExcalidrawToast = ({
  message,
  closable = false,
  duration,
}: ExcalidrawToast): string | number =>
  toast.info(message, {
    id: "excalidraw-toast",
    duration: duration ?? NOTIFICATION_DURATION_MS.info,
    dismissible: closable,
    closeButton: closable,
  });

const toasterStyle = { zIndex: stacking.notification } as CSSProperties;

/** The only Sonner host configuration in the application. */
export const NotificationHost = () => (
  <Toaster
    position="bottom-center"
    richColors
    closeButton
    expand
    visibleToasts={5}
    className="excalidash-z-notification"
    style={toasterStyle}
  />
);
