import { buildElements } from "../../integrations/excalidraw/elements";
import {
  readWidget,
  withExcalidashData,
  type WidgetKind,
} from "../../integrations/excalidraw/customData";

export const PDF_WIDGET_LINK = "excalidash://pdf-widget";
export const ASSET_WIDGET_LINK = "excalidash://asset-widget";
const PDF_WIDGET_WIDTH = 480;
export const PDF_WIDGET_HEIGHT = 680;
const TEXT_WIDGET_WIDTH = 520;
const TEXT_WIDGET_HEIGHT = 560;

export type AssetWidgetKind = WidgetKind;

/**
 * What a widget element carries, as the rest of the editor reads it.
 *
 * The stored shape belongs to the customData schema; this is the reading of it
 * that a widget consumer works with, keyed the way this module has always
 * named things.
 */
export type AssetWidgetData = {
  widgetKind: AssetWidgetKind;
  assetId: string;
};

type EmbeddableLike = {
  type?: string;
  link?: string | null;
  customData?: Readonly<Record<string, unknown>> | null;
};

const isPdfWidgetLink = (link: string) => link === PDF_WIDGET_LINK;
const isAssetWidgetLink = (link: string) => link === ASSET_WIDGET_LINK || isPdfWidgetLink(link);

/**
 * Whether Excalidraw may embed this link.
 *
 * Returning a boolean here answers for every link, which is why wiring
 * `isPdfWidgetLink` in directly switched off Excalidraw's own embeds: pasting a
 * YouTube or Vimeo link stopped producing a player and fell back to plain text.
 * `undefined` means "no opinion", so anything that is not our own widget is
 * judged by Excalidraw's normal rules again.
 */
export const validateEmbeddableLink = (link: string): true | undefined =>
  isAssetWidgetLink(link) ? true : undefined;

export const getAssetWidgetData = (element: EmbeddableLike): AssetWidgetData | null => {
  if (element.type !== "embeddable" || !element.link || !isAssetWidgetLink(element.link)) {
    return null;
  }

  const widget = readWidget(element);
  if (!widget) return null;

  // The two links are not interchangeable: the older one names a PDF and
  // nothing else, so a record claiming another kind behind it is inconsistent
  // rather than merely unexpected.
  if (element.link === PDF_WIDGET_LINK && widget.kind !== "pdf") return null;

  return { widgetKind: widget.kind, assetId: widget.assetId };
};

export const getPdfWidgetAssetId = (element: EmbeddableLike): string | null => {
  const data = getAssetWidgetData(element);
  return data?.widgetKind === "pdf" ? data.assetId : null;
};

export const createAssetWidgetElement = ({
  assetId,
  widgetKind,
  x,
  y,
}: {
  assetId: string;
  widgetKind: AssetWidgetKind;
  x: number;
  y: number;
}): Record<string, unknown> => {
  const width = widgetKind === "pdf" ? PDF_WIDGET_WIDTH : TEXT_WIDGET_WIDTH;
  const height = widgetKind === "pdf" ? PDF_WIDGET_HEIGHT : TEXT_WIDGET_HEIGHT;
  const [baseElement] = buildElements([
    { type: "rectangle", x: x - width / 2, y: y - height / 2, width, height },
  ]);
  return {
    ...baseElement,
    type: "embeddable" as const,
    link: ASSET_WIDGET_LINK,
    customData: withExcalidashData(baseElement, { widget: { kind: widgetKind, assetId } }),
  };
};

export const createPdfWidgetElement = ({
  assetId,
  x,
  y,
}: {
  assetId: string;
  x: number;
  y: number;
}): Record<string, unknown> => {
  const [baseElement] = buildElements([
    {
      type: "rectangle",
      x: x - PDF_WIDGET_WIDTH / 2,
      y: y - PDF_WIDGET_HEIGHT / 2,
      width: PDF_WIDGET_WIDTH,
      height: PDF_WIDGET_HEIGHT,
    },
  ]);
  return {
    ...baseElement,
    type: "embeddable" as const,
    link: PDF_WIDGET_LINK,
    customData: withExcalidashData(baseElement, { widget: { kind: "pdf", assetId } }),
  };
};
