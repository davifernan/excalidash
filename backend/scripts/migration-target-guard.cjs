/**
 * The decision behind `migrate-sqlite-to-postgres.cjs`'s refusal to write into
 * a target that is not safe to write into.
 *
 * Kept in its own file with NO dependencies -- no Prisma client, no
 * better-sqlite3 -- for one reason: the counterprobe that guards it runs in
 * CI's `node --test scripts/*.test.cjs` job, which installs only the repository
 * root's dependencies. A guard whose test cannot run is not a guard.
 *
 * What it decides, and why that is not "is the target empty":
 *
 * Until 02.09.2026 the script refused whenever the target held any row at all.
 * That made the documented migration impossible to complete. Step 1 of
 * docs/DEPLOYMENT.md creates the schema, and migration `20260823211543_add_team`
 * seeds `Team(id='default')` as part of it -- so a target prepared exactly as
 * the runbook says always held one row, the check always fired, and `--force`
 * then died on that row's unique id, which the source carries too from the same
 * migration. There was no path through the release's headline feature.
 *
 * The question that actually matters is not whether the target holds rows, but
 * whether it holds rows this migration will NOT overwrite -- those are another
 * instance's, and mixing two instances is the accident worth preventing. A row
 * whose id the source also has is about to be replaced by the source's version,
 * so it is no obstacle.
 */

/**
 * SQLite and PostgreSQL do not agree on the JS type an id arrives as: a numeric
 * key comes back as a number from one and can be compared against a string from
 * the other. Comparing normalised strings keeps that mismatch from reading as
 * "the source does not have this row", which would refuse a perfectly good
 * migration.
 */
const normaliseId = (value) => (value === null || value === undefined ? value : String(value));

/**
 * @param {Array<{model: string, targetIds?: unknown[], sourceIds?: Iterable<unknown>, comparable?: boolean, targetCount?: number}>} entries
 *   One entry per model. `comparable: false` is for models with a composite or
 *   missing primary key, where there is no single id to compare -- those fall
 *   back to the strict reading rather than guessing.
 * @returns {{ok: boolean, findings: string[]}} `ok` when nothing foreign was
 *   found. Findings name the model, how many rows are foreign, and one example,
 *   so an operator can go and look rather than take the refusal on faith.
 */
const findForeignRows = (entries) => {
  const findings = [];
  for (const entry of entries) {
    if (entry.comparable === false) {
      const count = entry.targetCount || 0;
      if (count > 0) {
        findings.push(`${entry.model}=${count} (no single-column id to compare)`);
      }
      continue;
    }
    const targetIds = entry.targetIds || [];
    if (targetIds.length === 0) continue;
    const sourceIds = new Set([...(entry.sourceIds || [])].map(normaliseId));
    const unknown = targetIds.filter((id) => !sourceIds.has(normaliseId(id)));
    if (unknown.length > 0) {
      findings.push(`${entry.model}=${unknown.length} (e.g. ${JSON.stringify(unknown[0])})`);
    }
  }
  return { ok: findings.length === 0, findings };
};

module.exports = { normaliseId, findForeignRows };
