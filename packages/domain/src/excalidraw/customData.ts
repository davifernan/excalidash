import { z } from "zod";

export const EXCALIDASH_NAMESPACE = "excalidash" as const;
export const EXCALIDASH_SCHEMA_VERSION = 2 as const;

export const stickyRecordSchema = z.object({
  color: z.string().min(1),
  ink: z.string().min(1),
  width: z.number().finite(),
  height: z.number().finite(),
  fontSize: z.number().finite(),
});
export type StickyRecord = z.infer<typeof stickyRecordSchema>;

export const widgetKindSchema = z.enum(["pdf", "markdown", "text"]);
export type WidgetKind = z.infer<typeof widgetKindSchema>;

export const widgetRecordSchema = z.object({
  kind: widgetKindSchema,
  assetId: z.string().min(1),
});
export type WidgetRecord = z.infer<typeof widgetRecordSchema>;

export const excalidashDataSchema = z
  .object({
    schemaVersion: z.literal(EXCALIDASH_SCHEMA_VERSION),
    sticky: stickyRecordSchema.optional(),
    widget: widgetRecordSchema.optional(),
  })
  .refine((value) => value.sticky !== undefined || value.widget !== undefined);
export type ExcalidashData = z.infer<typeof excalidashDataSchema>;

export type ExcalidashDataPatch = {
  readonly sticky?: StickyRecord | null;
  readonly widget?: WidgetRecord | null;
};
