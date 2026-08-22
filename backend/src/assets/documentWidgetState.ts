import { syncDrawingAssets } from "./assetService";

export const DOCUMENT_WIDGET_LIMIT = 200;
const DOCUMENT_WIDGET_ID = /^[\w-]{1,64}$/;
const DOCUMENT_WIDGET_LINKS = new Set(["excalidash://asset-widget", "excalidash://pdf-widget"]);
const DOCUMENT_WIDGET_KINDS = new Set(["pdf", "markdown", "text"]);

export class InvalidDocumentWidgetStateError extends Error {
  code = "INVALID_DOCUMENT_WIDGET_STATE" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidDocumentWidgetStateError";
  }
}

export type DocumentWidgetBinding = { elementId: string; assetId: string };

/** Extract validated document-widget bindings from client-authored scene data. */
export function documentWidgetBindings(elements: unknown): DocumentWidgetBinding[] {
  if (!Array.isArray(elements)) return [];
  const bindings: DocumentWidgetBinding[] = [];
  const byElement = new Map<string, string>();
  for (const element of elements) {
    if (!element || typeof element !== "object") continue;
    const el = element as any;
    if (el.isDeleted) continue;
    const customData = el.customData;
    if (
      el.type !== "embeddable" ||
      typeof el.link !== "string" ||
      !DOCUMENT_WIDGET_LINKS.has(el.link) ||
      !customData ||
      customData.schemaVersion !== 1 ||
      !DOCUMENT_WIDGET_KINDS.has(customData.widgetKind) ||
      typeof el.id !== "string" ||
      !DOCUMENT_WIDGET_ID.test(el.id) ||
      typeof customData.assetId !== "string" ||
      !DOCUMENT_WIDGET_ID.test(customData.assetId) ||
      (el.link === "excalidash://pdf-widget" && customData.widgetKind !== "pdf")
    ) {
      continue;
    }
    const previous = byElement.get(el.id);
    if (previous && previous !== customData.assetId) {
      throw new InvalidDocumentWidgetStateError(
        `Document widget "${el.id}" names more than one document.`,
      );
    }
    if (!previous) {
      byElement.set(el.id, customData.assetId);
      bindings.push({ elementId: el.id, assetId: customData.assetId });
    }
  }
  if (bindings.length > DOCUMENT_WIDGET_LIMIT) {
    throw new InvalidDocumentWidgetStateError(
      `A board can contain at most ${DOCUMENT_WIDGET_LIMIT} document widgets.`,
    );
  }
  return bindings;
}

export function referencedAssetIds(elements: unknown): string[] {
  return [...new Set(documentWidgetBindings(elements).map((binding) => binding.assetId))];
}

/** Reconcile asset access and materialized widget bindings in one transaction. */
export async function syncDrawingDocumentState(
  prisma: any,
  drawingId: string,
  elements: unknown,
): Promise<{ activated: string[]; detached: string[]; widgets: number }> {
  const bindings = documentWidgetBindings(elements);
  const assets = await syncDrawingAssets(
    prisma,
    drawingId,
    bindings.map((binding) => binding.assetId),
  );

  const wantedElementIds = bindings.map((binding) => binding.elementId);
  await prisma.documentPageView.deleteMany({
    where: {
      drawingId,
      ...(wantedElementIds.length > 0 ? { elementId: { notIn: wantedElementIds } } : {}),
    },
  });

  const existing = await prisma.documentPageView.findMany({
    where: { drawingId },
    select: { elementId: true, assetId: true },
  });
  const existingByElement = new Map(existing.map((row: any) => [row.elementId, row.assetId]));
  for (const binding of bindings) {
    const previousAssetId = existingByElement.get(binding.elementId);
    if (!previousAssetId) {
      await prisma.documentPageView.create({
        data: { drawingId, ...binding, page: 1, revision: 0 },
      });
    } else if (previousAssetId !== binding.assetId) {
      await prisma.documentPageView.update({
        where: { drawingId_elementId: { drawingId, elementId: binding.elementId } },
        data: { assetId: binding.assetId, page: 1, revision: { increment: 1 } },
      });
    }
  }

  return { ...assets, widgets: bindings.length };
}
