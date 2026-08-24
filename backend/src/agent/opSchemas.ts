/**
 * The narrow semantic operations API an agent token (NIL-382) is confined
 * to, instead of the full-scene `PUT /drawings/:id` a human editor session
 * trusts. Zod-validated, capped at MAX_OPS_PER_BATCH operations, with every
 * element's identity and version fields assigned server-side -- see
 * applyOps.ts for what "server-side" enforces beyond what these schemas
 * reject at the door.
 *
 * `type` is an open string, not an enum of known Excalidraw element kinds.
 * Upstream's ops API hardcoded its element type list and, by NIL-378's own
 * measurement, left this board's sticky-note and document-widget element
 * types uncovered. The fields this module actually needs to trust --
 * identity and geometry -- are validated strictly; everything else
 * (styling, custom widget payloads, ...) passes through unchecked.
 */
import { z } from "zod";

export const MAX_OPS_PER_BATCH = 50;

const finiteNumber = z.number().finite();

/** Fields the server always assigns -- rejected outright if a caller sends them. */
const SERVER_ASSIGNED_FIELDS = ["id", "version", "versionNonce", "updated", "isDeleted"] as const;

const rejectServerAssignedFields = <T extends z.ZodTypeAny>(schema: T, context: string) =>
  schema.superRefine((value, ctx) => {
    if (typeof value !== "object" || value === null) return;
    for (const field of SERVER_ASSIGNED_FIELDS) {
      if (field in (value as Record<string, unknown>)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${context} must not set "${field}" -- the server assigns it`,
          path: [field],
        });
      }
    }
  });

const elementGeometrySchema = z
  .object({
    type: z.string().trim().min(1).max(100),
    x: finiteNumber,
    y: finiteNumber,
    width: finiteNumber.optional(),
    height: finiteNumber.optional(),
    angle: finiteNumber.optional(),
  })
  .passthrough();

export const createOpSchema = z.object({
  op: z.literal("create"),
  element: rejectServerAssignedFields(elementGeometrySchema, "a create op's element"),
});

/**
 * `type` cannot be changed by an update -- an element that needs a different
 * type is deleted and recreated, so nothing here has to reconcile
 * type-specific fields left over from the element's previous shape.
 * `.omit({ type: true })` alone would not enforce this: the schema is
 * `.passthrough()`, so an omitted field is simply unvalidated, not rejected,
 * and a `type` key would ride through as an untyped passthrough field.
 * `type` is therefore rejected the same way the server-assigned fields are.
 */
const elementPatchSchema = elementGeometrySchema.omit({ type: true }).partial();

export const updateOpSchema = z.object({
  op: z.literal("update"),
  id: z.string().trim().min(1),
  patch: rejectServerAssignedFields(elementPatchSchema, "an update op's patch").superRefine(
    (patch, ctx) => {
      if (typeof patch === "object" && patch !== null && "type" in (patch as object)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'an update op\'s patch must not set "type" -- delete and recreate instead',
          path: ["type"],
        });
      }
    },
  ),
});

export const deleteOpSchema = z.object({
  op: z.literal("delete"),
  id: z.string().trim().min(1),
});

export const opSchema = z.discriminatedUnion("op", [createOpSchema, updateOpSchema, deleteOpSchema]);
export type Op = z.infer<typeof opSchema>;

export const opsBatchSchema = z.object({
  /** The drawing version this batch was computed against -- same optimistic-concurrency contract as the full-scene PUT. */
  version: z.number().int().nonnegative(),
  ops: z.array(opSchema).min(1).max(MAX_OPS_PER_BATCH),
});
export type OpsBatch = z.infer<typeof opsBatchSchema>;
