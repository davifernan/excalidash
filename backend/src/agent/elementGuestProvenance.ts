import { canonicalJson } from "./canonicalJson";
import { Prisma } from "../generated/client";

export type ElementGuestProvenanceStatus = "unknown" | "confirmed-clean" | "guest-touched";

export type ElementGuestProvenance = {
  elementId: string;
  status: ElementGuestProvenanceStatus;
};

type ProvenancePrisma = {
  $executeRaw(query: Prisma.Sql): Promise<number>;
  drawingElementGuestProvenance: {
    findMany(
      args: unknown,
    ): Promise<Array<{ elementId: string; everGuestTouched: boolean; revision: number }>>;
  };
};

export class ElementGuestProvenanceConflictError extends Error {
  constructor() {
    super("Element provenance changed while it was being confirmed");
  }
}

const uniqueElementIds = (ids: readonly string[]): string[] => [
  ...new Set(ids.filter((id) => typeof id === "string" && id.length > 0)),
];

/**
 * Read the three-state fact used by the guest-contribution compiler.
 *
 * A missing row is deliberately `unknown`, never an implicit clean bill for
 * legacy content. Consumers that authorize context inclusion must therefore
 * treat both `unknown` and `guest-touched` as fail-closed unless the current
 * board policy explicitly permits guest contribution.
 */
export const readElementGuestProvenance = async (
  prisma: ProvenancePrisma,
  drawingId: string,
  elementIds: readonly string[],
): Promise<ElementGuestProvenance[]> => {
  const ids = uniqueElementIds(elementIds);
  if (ids.length === 0) return [];
  const rows = await prisma.drawingElementGuestProvenance.findMany({
    where: { drawingId, elementId: { in: ids } },
    select: { elementId: true, everGuestTouched: true, revision: true },
  });
  const byId = new Map(rows.map((row) => [row.elementId, row.everGuestTouched]));
  return ids.map((elementId) => ({
    elementId,
    status: byId.has(elementId)
      ? byId.get(elementId)
        ? "guest-touched"
        : "confirmed-clean"
      : "unknown",
  }));
};

/**
 * Persist provenance only after an element mutation has passed authorization
 * and every other refusal gate.
 *
 * Guest contact always upserts `true`. Ordinary member mutations never update
 * an existing row, so moving or editing a guest-touched element cannot wash
 * the flag. Only elements the server can prove were newly created by this
 * member mutation receive a new `false` row; changing a legacy element with no
 * row leaves its provenance honestly unknown.
 */
export const recordSuccessfulElementMutation = async (params: {
  prisma: ProvenancePrisma;
  drawingId: string;
  isGuest: boolean;
  changedElementIds: readonly string[];
  createdElementIds: readonly string[];
}): Promise<void> => {
  const elementIds = uniqueElementIds(
    params.isGuest
      ? [...params.changedElementIds, ...params.createdElementIds]
      : params.createdElementIds,
  );
  if (elementIds.length === 0) return;
  const rows = Prisma.join(
    elementIds.map(
      (elementId) =>
        Prisma.sql`(${params.drawingId}, ${elementId}, ${params.isGuest}, CURRENT_TIMESTAMP)`,
    ),
  );
  // SQLite and PostgreSQL share this ON CONFLICT form. One statement per
  // admitted event keeps a multi-selection drag from becoming one round trip
  // per element. The member branch deliberately does nothing on conflict:
  // ordinary member contact can neither turn true into false nor turn an
  // unknown legacy element into known-clean.
  const conflict = params.isGuest
    ? Prisma.sql`DO UPDATE SET "everGuestTouched" = true, "revision" = "DrawingElementGuestProvenance"."revision" + 1, "updatedAt" = CURRENT_TIMESTAMP`
    : Prisma.sql`DO NOTHING`;
  await params.prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO "DrawingElementGuestProvenance"
        ("drawingId", "elementId", "everGuestTouched", "updatedAt")
      VALUES ${rows}
      ON CONFLICT ("drawingId", "elementId") ${conflict}
    `,
  );
};

/**
 * Materialize unknown legacy content at the explicit Context-registration
 * boundary. Registration cannot reconstruct authorship, so every missing row
 * in that existing frame becomes conservatively guest-touched. This is not an
 * inferred guest identity; it is the fail-closed persistence of uncertainty.
 */
export const markUnknownElementProvenanceGuestTouched = async (params: {
  prisma: ProvenancePrisma;
  drawingId: string;
  elementIds: readonly string[];
}): Promise<void> =>
  recordSuccessfulElementMutation({
    prisma: params.prisma,
    drawingId: params.drawingId,
    isGuest: true,
    changedElementIds: params.elementIds,
    createdElementIds: [],
  });

/** The sole deliberate reset seam. Callers authorize and audit the member. */
export const confirmElementGuestProvenance = async (
  prisma: ProvenancePrisma,
  drawingId: string,
  elementIds: readonly string[],
): Promise<void> => {
  const ids = uniqueElementIds(elementIds);
  if (ids.length === 0) return;
  const existing = await prisma.drawingElementGuestProvenance.findMany({
    where: { drawingId, elementId: { in: ids } },
    select: { elementId: true, everGuestTouched: true, revision: true },
  });
  const byId = new Map(existing.map((row) => [row.elementId, row]));
  for (const elementId of ids) {
    const row = byId.get(elementId);
    const changed = row
      ? await prisma.$executeRaw(
          Prisma.sql`
            UPDATE "DrawingElementGuestProvenance"
            SET "everGuestTouched" = false,
                "revision" = "revision" + 1,
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE "drawingId" = ${drawingId}
              AND "elementId" = ${elementId}
              AND "revision" = ${row.revision}
          `,
        )
      : await prisma.$executeRaw(
          Prisma.sql`
            INSERT INTO "DrawingElementGuestProvenance"
              ("drawingId", "elementId", "everGuestTouched", "revision", "updatedAt")
            VALUES (${drawingId}, ${elementId}, false, 1, CURRENT_TIMESTAMP)
            ON CONFLICT ("drawingId", "elementId") DO NOTHING
          `,
        );
    if (changed !== 1) throw new ElementGuestProvenanceConflictError();
  }
};

/**
 * NIL-677 `agent_context:contribute`, Gate 2 -- the actual guarantee (Gate 1,
 * `assertGuestElementWriteAllowed` in boardContexts.ts, is only prevention;
 * it answers a different question -- "may this actor write here now" versus
 * this function's "should this content, given what is known about who
 * touched it, be read into a compiled Agent Context").
 *
 * `confirmed-clean` content always contributes. `guest-touched` and
 * `unknown` are both fail-closed by default -- an absent provenance row is
 * never an implicit clean bill, exactly as `readElementGuestProvenance`'s own
 * contract says -- and only contribute when the board's policy explicitly
 * allows guest contribution.
 *
 * The one place this rule is written down. `executeAgentBoardTool`
 * (boardMount.ts) is its only caller today; a future Context-tab preview
 * that shows a human what the next run would read must call this same
 * function rather than re-deriving the rule, the same reason NIL-675's chat
 * and compiler readers share one `resolveThreadState`.
 */
export const isEligibleForAgentContribution = (params: {
  status: ElementGuestProvenanceStatus;
  agentContextContributeEnabled: boolean;
}): boolean => params.status === "confirmed-clean" || params.agentContextContributeEnabled;

type SceneElement = Record<string, unknown>;

const sceneElementsById = (elements: readonly unknown[]): Map<string, SceneElement> =>
  new Map(
    elements
      .filter(
        (element): element is SceneElement & { id: string } =>
          typeof element === "object" &&
          element !== null &&
          !Array.isArray(element) &&
          typeof (element as SceneElement).id === "string",
      )
      .map((element) => [element.id, element]),
  );

/** Identify precisely which ids a full-scene HTTP replacement changed. */
export const diffSceneElementIds = (
  before: readonly unknown[],
  after: readonly unknown[],
): { changedElementIds: string[]; createdElementIds: string[] } => {
  const beforeById = sceneElementsById(before);
  const afterById = sceneElementsById(after);
  const createdElementIds: string[] = [];
  const changedElementIds: string[] = [];
  for (const [elementId, element] of afterById) {
    const previous = beforeById.get(elementId);
    if (!previous) {
      createdElementIds.push(elementId);
      changedElementIds.push(elementId);
    } else if (canonicalJson(previous) !== canonicalJson(element)) {
      changedElementIds.push(elementId);
    }
  }
  for (const elementId of beforeById.keys()) {
    if (!afterById.has(elementId)) changedElementIds.push(elementId);
  }
  return {
    changedElementIds: uniqueElementIds(changedElementIds),
    createdElementIds: uniqueElementIds(createdElementIds),
  };
};

/** Explicit frame ancestry, never geometry, defines Context membership. */
export const elementIdsInContextFrame = (
  elements: readonly SceneElement[],
  frameElementId: string,
): string[] => {
  const liveById = new Map(
    elements
      .filter(
        (element): element is SceneElement & { id: string } =>
          element.isDeleted !== true && typeof element.id === "string",
      )
      .map((element) => [element.id, element]),
  );
  const belongs = (element: SceneElement & { id: string }): boolean => {
    if (element.id === frameElementId) return true;
    let parentId = typeof element.frameId === "string" ? element.frameId : null;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      if (parentId === frameElementId) return true;
      visited.add(parentId);
      const parent = liveById.get(parentId);
      parentId = parent && typeof parent.frameId === "string" ? parent.frameId : null;
    }
    return false;
  };
  return [...liveById.values()]
    .filter(belongs)
    .map((element) => element.id)
    .sort();
};
