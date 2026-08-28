import { z } from "zod";

export const documentKindSchema = z.enum(["MARKDOWN", "TEXT"]);
export type DocumentKind = z.infer<typeof documentKindSchema>;

export const documentPaginationRequestSchema = z.object({
  source: z.string(),
  kind: documentKindSchema,
  budget: z.number().int().positive().optional(),
});
export type DocumentPaginationRequest = z.infer<typeof documentPaginationRequestSchema>;
