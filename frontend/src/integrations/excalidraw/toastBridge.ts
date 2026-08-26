import { useMemo } from "react";
import { notifyExcalidrawToast, type ExcalidrawToast } from "../../notifications";
import "./toastBridge.css";

const fingerprint = ({ message, closable, duration }: ExcalidrawToast) =>
  JSON.stringify([message, closable ?? false, duration ?? null]);

/**
 * Mirror Excalidraw's single toast state into the application notification
 * facade. `onChange` repeats the same app state for unrelated canvas changes,
 * so identity is held until upstream clears its toast.
 */
export const createExcalidrawToastForwarder = () => {
  let current: string | null = null;
  return (toast: ExcalidrawToast | null | undefined): void => {
    if (!toast) {
      current = null;
      return;
    }
    const next = fingerprint(toast);
    if (next === current) return;
    current = next;
    notifyExcalidrawToast(toast);
  };
};

export const useExcalidrawToastBridge = () => useMemo(() => createExcalidrawToastForwarder(), []);
