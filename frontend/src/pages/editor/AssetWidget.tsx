import { PdfWidget } from "./PdfWidget";
import { TextDocumentWidget } from "./TextDocumentWidget";
import type { AssetWidgetData, AssetWidgetKind } from "./pdfWidgetElements";
import type { DocumentPageSharing } from "./useSharedDocumentPage";
import type { FloatingToolbarTarget } from "./floatingToolbarGeometry";

type AssetWidgetProps = {
  data: AssetWidgetData;
  drawingId: string;
  theme: "light" | "dark";
  canEdit: boolean;
  sharing: DocumentPageSharing;
  toolbar: FloatingToolbarTarget | null;
};

type WidgetComponent = (props: AssetWidgetProps) => React.ReactNode;

const widgets: Record<AssetWidgetKind, WidgetComponent> = {
  pdf: ({ data, drawingId, theme, canEdit, sharing, toolbar }) => (
    <PdfWidget
      assetId={data.assetId}
      drawingId={drawingId}
      theme={theme}
      canEdit={canEdit}
      sharing={sharing}
      toolbar={toolbar}
    />
  ),
  markdown: ({ data, drawingId, theme, canEdit, sharing, toolbar }) => (
    <TextDocumentWidget
      assetId={data.assetId}
      drawingId={drawingId}
      theme={theme}
      canEdit={canEdit}
      widgetKind="markdown"
      sharing={sharing}
      toolbar={toolbar}
    />
  ),
  text: ({ data, drawingId, theme, canEdit, sharing, toolbar }) => (
    <TextDocumentWidget
      assetId={data.assetId}
      drawingId={drawingId}
      theme={theme}
      canEdit={canEdit}
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
