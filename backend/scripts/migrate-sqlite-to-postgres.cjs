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
const { normaliseId, findForeignRows } = require("./migration-target-guard.cjs");

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
/**
 * The model's single-column primary key, or null when it has none (composite
 * key, or no id at all). Read from the schema rather than assumed, so a model
 * that changes its key does not silently fall through the wrong branch.
 */
const singleIdField = (modelName) => {
  const model = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === modelName);
  if (!model) return null;
  if (
    model.primaryKey &&
    Array.isArray(model.primaryKey.fields) &&
    model.primaryKey.fields.length > 0
  ) {
    return model.primaryKey.fields.length === 1 ? model.primaryKey.fields[0] : null;
  }
  const idFields = model.fields.filter((field) => field.isId);
  return idFields.length === 1 ? idFields[0].name : null;
};

const sourceIdSet = (source, modelName, idField) => {
  try {
    return new Set(
      source
        .prepare(`SELECT ${quoted(idField)} AS id FROM ${quoted(modelName)}`)
        .all()
        .map((row) => normaliseId(row.id)),
    );
  } catch (error) {
    // A table the old database never had contributes no ids -- and then any
    // row in the target is, correctly, unknown to the source.
    if (!String(error?.message ?? error).includes("no such table")) throw error;
    return new Set();
  }
};

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

  // A SQLite database in WAL mode keeps committed data in a `-wal` sidecar
  // until it is checkpointed. Copy `dev.db` on its own and everything still in
  // that sidecar is simply absent -- and this script cannot tell, because it
  // compares the source it was given against the target and finds them equal.
  //
  // Measured 02.09.2026: a copy taken exactly as docs/DEPLOYMENT.md implied
  // left a 1,030,032-byte `-wal` behind. The boards, collections and comments
  // lived in it. The migration reported "Every table arrived with the same
  // number of rows it left with" and exited 0, having moved a user and nothing
  // else. Silent loss under a success message is the one outcome a migration
  // tool must never produce, so this refuses instead.
  const walPath = `${sourcePath}-wal`;
  const journalMode = String(source.pragma("journal_mode", { simple: true }) || "").toLowerCase();
  const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  if (journalMode === "wal" && walBytes > 0 && !has("--accept-wal")) {
    throw new Error(
      `${sourcePath} is in WAL mode and its write-ahead log holds ${walBytes} bytes ` +
        `(${walPath}). better-sqlite3 reads that log, so this run WOULD see the data -- ` +
        "but a copy of the database file taken without its `-wal` and `-shm` sidecars " +
        "would not, and this script cannot tell the difference afterwards. Either point " +
        "--from at the live database directory with its sidecars intact (what you appear " +
        "to be doing), and pass --accept-wal to say so, or checkpoint the source first " +
        "(stop the instance, then `PRAGMA wal_checkpoint(TRUNCATE)`).",
    );
  }
  if (journalMode === "wal" && walBytes === 0) {
    console.log(
      `Source is in WAL mode with an empty write-ahead log -- either checkpointed, or ` +
        `copied without its sidecars. If ${path.basename(sourcePath)} was copied from a ` +
        "running instance, verify the row counts below against the live instance before " +
        "trusting them.",
    );
  }

  const target = new PrismaClient();

  const report = [];
  try {
    // What makes a target unsafe is rows this migration will NOT overwrite --
    // another instance's data -- not rows as such.
    //
    // Counting any row at all was wrong and made the documented procedure
    // impossible to complete (measured 02.09.2026): step 1 of
    // docs/DEPLOYMENT.md creates the schema with `provider-prisma.cjs migrate
    // deploy`, and migration `20260823211543_add_team` seeds
    // `Team(id='default')` while doing so. A target prepared exactly as the
    // runbook says therefore always held one row, this check always fired, and
    // `--force` then died on that same row's unique id -- leaving no path at
    // all for the release's headline feature.
    //
    // The rule now: every id already in the target must also exist in the
    // source. Then the copy below overwrites it and nothing is mixed. A
    // foreign instance's rows carry ids the source has never seen, so they are
    // still refused -- and named, so the operator can look.
    // Reading is here; the decision is in migration-target-guard.cjs, where a
    // counterprobe can drive it without a database.
    const entries = [];
    for (const model of order) {
      const delegate = target[model.charAt(0).toLowerCase() + model.slice(1)];
      const idField = singleIdField(model);
      if (!idField) {
        entries.push({ model, comparable: false, targetCount: await delegate.count() });
        continue;
      }
      const targetRows = await delegate.findMany({ select: { [idField]: true } });
      entries.push({
        model,
        targetIds: targetRows.map((row) => row[idField]),
        sourceIds: targetRows.length > 0 ? sourceIdSet(source, model, idField) : [],
      });
    }
    const verdict = findForeignRows(entries);
    if (!verdict.ok && !force && !dryRun) {
      throw new Error(
        `The target holds rows the source does not (${verdict.findings.join(", ")}). ` +
          "Migrating into it would mix two instances. Use --force only if that is what you mean.",
      );
    }

    // One transaction around the whole copy. Without it a failure part-way
    // left the target holding whatever had already been written -- measured
    // 02.09.2026: a run that died on `Team` left `User=1` behind, the next
    // attempt was refused because the target "already holds rows", and the
    // only way forward was to drop the database, which nothing said. The
    // script's one reassurance ("Nothing was removed from the source
    // database") was true and beside the point.
    //
    // The timeout is deliberately far larger than Prisma's 5 s default: this
    // runs once, over a whole instance, and a migration that gives up half way
    // is the failure mode being fixed here.
    const runCopy = async (tx) => {
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

        const delegate = tx[model.charAt(0).toLowerCase() + model.slice(1)];
        if (!dryRun && rows.length > 0) {
          const idField = singleIdField(model);
          // One row at a time on purpose: a createMany that rejects the batch
          // says which table failed and not which row, and this runs once.
          //
          // upsert, not create, wherever there is a single-column key: the
          // schema itself seeds rows (`Team(id='default')`), so source and
          // target legitimately share ids and a plain create dies on the first
          // one. The source is authoritative, so its version wins.
          for (const row of rows) {
            const data = coerce(model, row);
            if (idField && data[idField] !== undefined && data[idField] !== null) {
              await delegate.upsert({
                where: { [idField]: data[idField] },
                create: data,
                update: data,
              });
            } else {
              await delegate.create({ data });
            }
          }
        }
        const after = dryRun ? "-" : await delegate.count();
        report.push({ model, source: rows.length, target: after });
      }
    };

    if (dryRun) {
      // Nothing is written, so there is nothing to roll back -- and wrapping a
      // read-only pass in a transaction would only add a timeout to it.
      await runCopy(target);
    } else {
      await target.$transaction(runCopy, {
        maxWait: 60_000,
        timeout: Number(process.env.MIGRATE_TRANSACTION_TIMEOUT_MS || 30 * 60 * 1000),
      });
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

if (require.main === module)
  main().catch((error) => {
    console.error("");
    console.error(String(error?.message ?? error));
    console.error("");
    console.error("The source database was opened read-only and is unchanged.");
    // Said explicitly because the previous wording ("nothing was removed from the
    // source") was true while the target had been left half-filled, which is the
    // state an operator actually needs to know about.
    console.error("The target was rolled back: the copy runs in one transaction, so it holds");
    console.error("whatever it held before this run. You can fix the cause and run again.");
    process.exit(1);
  });
