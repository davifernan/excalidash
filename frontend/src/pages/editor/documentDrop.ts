import { toast } from "sonner";
import { isAxiosError, uploadDocumentAsset, type UploadDocumentKind } from "../../api";
import type { SceneCapability } from "../../integrations/excalidraw/capabilities";
import type { ElementId, NewElement } from "../../integrations/excalidraw/types";
import { createAssetWidgetElement, PDF_WIDGET_HEIGHT } from "./pdfWidgetElements";

type DropPoint = { x: number; y: number };

const capabilityError = (failure: { seam: string; code: string }) =>
  new Error(`${failure.seam} failed (${failure.code})`);

/**
 * The element as it was built, plus the fields the contract names.
 *
 * The first version listed seven fields and dropped the rest. But the input
 * arrives from `createAssetWidgetElement` -> `buildElements` -> Excalidraw's own
 * `convertToExcalidrawElements`, already complete: angle, seed, roundness,
 * version, versionNonce, groupIds, opacity, strokeWidth, fillStyle, roughness.
 * None of it survived, and `reconcileElements` decides a collaborative merge on
 * exactly that bookkeeping -- so a dropped PDF risked being overwritten by an
 * older copy of itself.
 *
 * `fromNewElement` in the adapter fixed this same mistake one function further
 * in and its comment says so. It cannot help here: the whitelist ran first, and
 * there was nothing left to restore. `stickyPlacement.ts` never had the bug --
 * it passes its note through unprojected.
 */
export const asWidgetElement = (element: Record<string, unknown>): NewElement =>
  ({
    ...element,
    id: String(element.id) as ElementId,
    type: "embeddable",
    x: Number(element.x),
    y: Number(element.y),
    width: Number(element.width),
    height: Number(element.height),
    link: String(element.link),
  }) as unknown as NewElement;

const responseMessage = (error: unknown): string | null => {
  if (!isAxiosError(error)) return null;
  const data = error.response?.data;
  if (typeof data !== "object" || data === null) return null;
  const message = (data as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
};

const getDocumentUploadErrorMessage = (error: unknown, kind: UploadDocumentKind): string => {
  const label = kind === "pdf" ? "PDF" : kind === "markdown" ? "Markdown file" : "text file";
  if (!isAxiosError(error)) return `Failed to upload the ${label}.`;
  const status = error.response?.status;
  const serverMessage = responseMessage(error);
  if (status === 413) {
    const limit = serverMessage?.match(/(\d+(?:\.\d+)?)\s*MB/i)?.[1];
    return limit ? `The file is too large (max ${limit} MB).` : "The file is too large.";
  }
  if (status === 507) return "No storage space is available.";
  if (status === 422) return serverMessage || `The ${label} could not be read.`;
  if (status === 403) {
    return "You can view this board, but you cannot add anything to it.";
  }
  if (status === 415) return serverMessage || "This document type is not supported.";
  return serverMessage || `Failed to upload the ${label}.`;
};

const isPdfFile = (file: File) =>
  file.type.toLowerCase() === "application/pdf" ||
  (file.type === "" && file.name.toLowerCase().endsWith(".pdf"));

const documentKindForFile = (file: File): UploadDocumentKind | null => {
  if (isPdfFile(file)) return "pdf";
  const name = file.name.toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (name.endsWith(".txt")) return "text";
  return null;
};

export const getDocumentDropFiles = (files: File[]): File[] | null =>
  files.length > 0 && files.every((file) => documentKindForFile(file) !== null) ? files : null;

export const addDroppedDocumentWidgets = async ({
  drawingId,
  files,
  point,
  scene,
}: {
  drawingId: string;
  files: File[];
  point: DropPoint;
  scene: SceneCapability;
}) => {
  const elements: NewElement[] = [];
  for (const [index, file] of files.entries()) {
    const kind = documentKindForFile(file);
    if (!kind) continue;
    const toastId = `document-upload-${Date.now()}-${index}`;
    toast.loading(`Uploading ${file.name}...`, { id: toastId, description: "0%" });
    try {
      const asset = await uploadDocumentAsset(drawingId, file, kind, (progress) => {
        toast.loading(`Uploading ${file.name}...`, {
          id: toastId,
          description: `${progress}%`,
        });
      });
      elements.push(
        asWidgetElement(
          createAssetWidgetElement({
            assetId: asset.id,
            widgetKind: kind,
            x: point.x,
            y: point.y + index * (PDF_WIDGET_HEIGHT + 24),
          }),
        ),
      );
      toast.success(`${file.name} added`, { id: toastId });
    } catch (error) {
      toast.error(getDocumentUploadErrorMessage(error, kind), { id: toastId });
    }
  }

  if (elements.length === 0) return;
  const applied = scene.apply(
    [
      { kind: "insert", elements },
      { kind: "select", ids: elements.map((element) => element.id) },
    ],
    { capture: "immediate" },
  );
  if (!applied.ok) throw capabilityError(applied);
};

export const addDroppedPdfWidgets = addDroppedDocumentWidgets;
