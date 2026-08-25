import { PdfWidget } from "./PdfWidget";
import { TextDocumentWidget } from "./TextDocumentWidget";
import type { AssetWidgetData, AssetWidgetKind } from "./pdfWidgetElements";
import type { DocumentPageSharing } from "./useSharedDocumentPage";
import type { FloatingToolbarTarget } from "./floatingToolbarGeometry";

type AssetWidgetProps = {
  data: AssetWidgetData;
  drawingId: string;
  theme: "light" | "dark";
  sharing: DocumentPageSharing;
  toolbar: FloatingToolbarTarget | null;
};

type WidgetComponent = (props: AssetWidgetProps) => React.ReactNode;

const widgets: Record<AssetWidgetKind, WidgetComponent> = {
  pdf: ({ data, drawingId, theme, sharing, toolbar }) => (
    <PdfWidget
      assetId={data.assetId}
      drawingId={drawingId}
      theme={theme}
      sharing={sharing}
      toolbar={toolbar}
    />
  ),
  markdown: ({ data, drawingId, theme, sharing, toolbar }) => (
    <TextDocumentWidget
      assetId={data.assetId}
      drawingId={drawingId}
      theme={theme}
      widgetKind="markdown"
      sharing={sharing}
      toolbar={toolbar}
    />
  ),
  text: ({ data, drawingId, theme, sharing, toolbar }) => (
    <TextDocumentWidget
      assetId={data.assetId}
      drawingId={drawingId}
      theme={theme}
      widgetKind="text"
      sharing={sharing}
      toolbar={toolbar}
    />
  ),
};

export const AssetWidget = (props: AssetWidgetProps) => {
  const Widget = widgets[props.data.widgetKind];
  return <Widget {...props} />;
};
