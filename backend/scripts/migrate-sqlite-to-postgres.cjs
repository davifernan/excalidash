#!/usr/bin/env node
/**
 * Move an existing SQLite instance onto PostgreSQL.
 *
 * Written for one migration of one instance, which is what it was asked for --
 * not a supported product feature that has to survive every foreign data
 * shape. It is deliberately small, and deliberately loud.
 *
 * Three properties matter more than speed:
 *
 * 1. **The source is never written.** The SQLite file is opened read-only. If
 *    anything here goes wrong, the old instance still starts.
 * 2. **Counts are printed side by side, per table.** "Success" is not a result.
 *    A table that arrives empty must be visible as a number, not inferred from
 *    the absence of an error.
 * 3. **Order comes from the schema, not from this file.** Insert order follows
 *    the relations Prisma already knows about, so a model added later cannot
 *    silently land in the wrong place.
 *
 * Usage:
 *   DATABASE_PROVIDER=postgresql DATABASE_URL=postgresql://... \
 *     node scripts/migrate-sqlite-to-postgres.cjs --from /app/prisma/dev.db
 *
 *   --dry-run   read and count, write nothing
 *   --force     write even though the target already holds rows
 */
const path = require("node:path");
const fs = require("node:fs");

const Database = require("better-sqlite3");
const { PrismaClient, Prisma } = require("../src/generated/client");

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? null : args[at + 1];
};
const has = (flag) => args.includes(flag);

const sourcePath = valueOf("--from") || path.resolve(__dirname, "..", "prisma", "dev.db");
const dryRun = has("--dry-run");
const force = has("--force");

/**
 * Insert order, derived from the relations in the schema.
 *
 * A model must come after every model it points at. Prisma's DMMF names those
 * through `relationFromFields` -- a field that carries the foreign key, rather
 * than the back-reference. Self-references are ignored: a row pointing at its
 * own table cannot be ordered around, and the data has none that matter.
 */
const insertOrder = () => {
  const models = Prisma.dmmf.datamodel.models;
  const dependsOn = new Map(
    models.map((model) => [
      model.name,
      new Set(
        model.fields
          .filter((field) => field.relationFromFields && field.relationFromFields.length > 0)
          .map((field) => field.type)
          .filter((target) => target !== model.name),
      ),
    ]),
  );

  const ordered = [];
  const placed = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (const model of models) {
      if (placed.has(model.name)) continue;
      const blockers = [...dependsOn.get(model.name)].filter((dep) => !placed.has(dep));
      if (blockers.length > 0) continue;
      ordered.push(model.name);
      placed.add(model.name);
      progress = true;
    }
  }

  const cyclic = models.filter((model) => !placed.has(model.name)).map((model) => model.name);
  if (cyclic.length > 0) {
    // Not silently appended: a cycle means the order this script relies on does
    // not exist, and guessing one would produce a foreign-key failure halfway
    // through a migration.
    throw new Error(
      `Cannot order these models -- their relations form a cycle: ${cyclic.join(", ")}`,
    );
  }
  return ordered;
};

const quoted = (name) => `"${name}"`;

const main = async () => {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`No SQLite database at ${sourcePath}`);
  }
  if (!String(process.env.DATABASE_URL || "").startsWith("postgres")) {
    throw new Error("DATABASE_URL must point at PostgreSQL for this to be a migration.");
  }

  const order = insertOrder();
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const target = new PrismaClient();

  const report = [];
  try {
    const existing = [];
    for (const model of order) {
      const delegate = target[model.charAt(0).toLowerCase() + model.slice(1)];
      const count = await delegate.count();
      if (count > 0) existing.push(`${model}=${count}`);
    }
    if (existing.length > 0 && !force && !dryRun) {
      throw new Error(
        `The target already holds rows (${existing.join(", ")}). ` +
          "Migrating into it would mix two instances. Use --force only if that is what you mean.",
      );
    }

    for (const model of order) {
      let rows = [];
      try {
        rows = source.prepare(`SELECT * FROM ${quoted(model)}`).all();
      } catch (error) {
        // A table the old database never had is not an error: the schema grew.
        if (!String(error?.message ?? error).includes("no such table")) throw error;
        report.push({ model, source: "-", target: "-", note: "table absent in source" });
        continue;
      }

      const delegate = target[model.charAt(0).toLowerCase() + model.slice(1)];
      if (!dryRun && rows.length > 0) {
        // One row at a time on purpose: a createMany that rejects the batch
        // says which table failed and not which row, and this runs once.
        for (const row of rows) {
          await delegate.create({ data: coerce(model, row) });
        }
      }
      const after = dryRun ? "-" : await delegate.count();
      report.push({ model, source: rows.length, target: after });
    }
  } finally {
    source.close();
    await target.$disconnect();
  }

  const width = Math.max(...report.map((line) => line.model.length));
  console.log("");
  console.log(`${"table".padEnd(width)}  source  target`);
  for (const line of report) {
    const mismatch = line.target !== "-" && line.source !== "-" && line.source !== line.target;
    console.log(
      `${line.model.padEnd(width)}  ${String(line.source).padStart(6)}  ${String(line.target).padStart(6)}` +
        (mismatch ? "   <-- MISMATCH" : line.note ? `   ${line.note}` : ""),
    );
  }
  const mismatched = report.filter(
    (line) => line.target !== "-" && line.source !== "-" && line.source !== line.target,
  );
  console.log("");
  if (mismatched.length > 0) {
    throw new Error(
      `${mismatched.length} table(s) did not arrive complete: ${mismatched.map((l) => l.model).join(", ")}`,
    );
  }
  console.log(
    dryRun
      ? "Dry run only -- nothing was written. The counts above are what would move."
      : "Every table arrived with the same number of rows it left with.",
  );
  console.log(`The source at ${sourcePath} was opened read-only and is unchanged.`);
};

/**
 * SQLite hands back what it stored; PostgreSQL wants the column's real type.
 * Booleans arrive as 0/1 and dates as milliseconds or strings, so each field is
 * converted using the type the schema declares rather than guessed from the
 * value -- a 0 is a false or a number depending on the column, and only the
 * schema knows which.
 */
const fieldTypes = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    new Map(model.fields.filter((f) => f.kind !== "object").map((f) => [f.name, f.type])),
  ]),
);

function coerce(model, row) {
  const types = fieldTypes.get(model);
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const type = types?.get(key);
    if (!type || value === null || value === undefined) {
      if (type) out[key] = value ?? null;
      continue;
    }
    if (type === "Boolean") out[key] = value === 1 || value === true || value === "true";
    else if (type === "DateTime")
      out[key] = typeof value === "number" ? new Date(value) : new Date(String(value));
    else if (type === "Json") out[key] = typeof value === "string" ? JSON.parse(value) : value;
    else out[key] = value;
  }
  return out;
}

main().catch((error) => {
  console.error("");
  console.error(String(error?.message ?? error));
  console.error("");
  console.error("Nothing was removed from the source database.");
  process.exit(1);
});
