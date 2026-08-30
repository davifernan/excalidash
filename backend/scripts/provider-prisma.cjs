#!/usr/bin/env node

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const backendRoot = path.resolve(__dirname, "..");
const prismaDir = path.resolve(backendRoot, "prisma");
const migrationsDir = path.resolve(prismaDir, "migrations");
const schemaFile = path.resolve(prismaDir, "schema.prisma");
const localTmpRoot = path.resolve(backendRoot, ".prisma-workspaces.tmp");
const validProviders = new Set(["sqlite", "postgresql"]);

const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";

const inferProvider = (env = process.env) => {
  const configured = String(env.DATABASE_PROVIDER || "").trim();
  if (validProviders.has(configured)) return configured;
  if (configured) {
    throw new Error(
      `DATABASE_PROVIDER must be 'sqlite' or 'postgresql', got '${configured}'`
    );
  }

  const databaseUrl = String(env.DATABASE_URL || "").trim();
  if (/^postgres(?:ql)?:\/\//i.test(databaseUrl)) return "postgresql";
  if (databaseUrl.startsWith("file:") || databaseUrl.length === 0) return "sqlite";

  return "sqlite";
};

const normalizeDatabaseUrl = (rawUrl) => {
  const defaultDbPath = path.resolve(prismaDir, "dev.db");

  if (!rawUrl || String(rawUrl).trim().length === 0) {
    return `file:${defaultDbPath}`;
  }

  const value = String(rawUrl);
  if (!value.startsWith("file:")) return value;

  const filePath = value.replace(/^file:/, "");
  const normalizedRelative = filePath.replace(/^\.\/?/, "");
  const hasLeadingPrismaDir =
    normalizedRelative === "prisma" || normalizedRelative.startsWith("prisma/");

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(hasLeadingPrismaDir ? backendRoot : prismaDir, normalizedRelative);

  return `file:${absolutePath}`;
};

const rewriteSchemaProvider = (schema, provider) => {
  const datasourceProviderPattern =
    /(datasource\s+db\s*{[\s\S]*?provider\s*=\s*)(?:env\("[^"]*"\)|"[^"]*")/;
  if (!datasourceProviderPattern.test(schema)) {
    throw new Error("Could not find datasource provider in prisma/schema.prisma");
  }
  return schema.replace(datasourceProviderPattern, `$1"${provider}"`);
};

/**
 * `generator client { output = "..." }` is resolved relative to wherever the
 * schema *file* that names it lives -- not `cwd`. A copy of the schema
 * anywhere other than `prisma/` therefore has to carry an absolute
 * replacement for that path, or a successful `generate` writes the client
 * to a location nothing in this app ever imports from.
 */
const rewriteGeneratorOutput = (schema, absoluteOutputPath) => {
  const generatorOutputPattern = /(generator\s+client\s*{[\s\S]*?output\s*=\s*)"[^"]*"/;
  if (!generatorOutputPattern.test(schema)) {
    throw new Error("Could not find generator client output in prisma/schema.prisma");
  }
  // JSON.stringify, not a template literal: it escapes backslashes correctly
  // for a Windows absolute path too, where `path.resolve` would embed them raw.
  return schema.replace(generatorOutputPattern, `$1${JSON.stringify(absoluteOutputPath)}`);
};

const copyDirectoryContents = (fromDir, toDir) => {
  fs.mkdirSync(toDir, { recursive: true });
  if (!fs.existsSync(fromDir)) return;

  for (const entry of fs.readdirSync(fromDir)) {
    const fromPath = path.join(fromDir, entry);
    const toPath = path.join(toDir, entry);
    fs.cpSync(fromPath, toPath, { recursive: true });
  }
};

const getWorkspaceTempRoots = () => {
  const roots = [];
  const addRoot = (root) => {
    if (root && !roots.includes(root)) roots.push(root);
  };

  addRoot(os.tmpdir());
  addRoot(localTmpRoot);

  return roots;
};

const createProviderWorkspaceInRoot = (provider, providerMigrationsDir, tempRoot) => {
  fs.mkdirSync(tempRoot, { recursive: true });

  const workspaceDir = fs.mkdtempSync(path.join(tempRoot, "excalidash-prisma-"));
  const workspaceMigrationsDir = path.join(workspaceDir, "migrations");
  const workspaceSchema = path.join(workspaceDir, "schema.prisma");

  try {
    fs.writeFileSync(
      workspaceSchema,
      rewriteSchemaProvider(fs.readFileSync(schemaFile, "utf8"), provider)
    );
    copyDirectoryContents(providerMigrationsDir, workspaceMigrationsDir);
  } catch (error) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    throw error;
  }

  return {
    dir: workspaceDir,
    tempRoot,
    migrationsDir: workspaceMigrationsDir,
    schema: workspaceSchema,
    providerMigrationsDir,
  };
};

const createProviderWorkspace = (provider) => {
  const providerMigrationsDir = path.join(migrationsDir, provider);
  if (!fs.existsSync(providerMigrationsDir)) {
    throw new Error(`Missing Prisma migrations for provider '${provider}'`);
  }

  let lastError;
  for (const tempRoot of getWorkspaceTempRoots()) {
    try {
      return createProviderWorkspaceInRoot(provider, providerMigrationsDir, tempRoot);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

const persistProviderMigrations = (workspace) => {
  const tmpProviderDir = `${workspace.providerMigrationsDir}.tmp-${process.pid}`;
  fs.rmSync(tmpProviderDir, { recursive: true, force: true });
  copyDirectoryContents(workspace.migrationsDir, tmpProviderDir);
  fs.rmSync(workspace.providerMigrationsDir, { recursive: true, force: true });
  fs.renameSync(tmpProviderDir, workspace.providerMigrationsDir);
};

const withSchemaArg = (args, schema) => {
  if (args.some((arg) => arg === "--schema" || arg.startsWith("--schema="))) {
    return args;
  }
  return [...args, "--schema", schema];
};

/**
 * `generate` never touches migrations, so the temp-workspace copy the other
 * subcommands need (a real, provider-specific `migrations/` directory next
 * to the schema) buys it nothing -- and copying it under `os.tmpdir()`
 * actively breaks two things at once:
 *
 * 1. Prisma's own "auto-install on generate" step infers the *project root*
 *    to install into from the `--schema` path, not from `cwd`. A schema
 *    under `/tmp` has no ancestor `package.json`, so it falls back to `/`
 *    and `npm i prisma@... -D` there fails outright (NIL-597) -- the
 *    reproducible crash this fix exists for.
 * 2. Even past that: the generator block's `output = "../src/generated/
 *    client"` is resolved relative to the schema file's own location. From
 *    a `/tmp` copy that resolves to a `/tmp/src/generated/client` that
 *    nothing in this app ever imports from -- a client would "generate"
 *    successfully and land somewhere useless.
 *
 * An earlier version of this fix rewrote the real `prisma/schema.prisma` in
 * place and restored it in a `finally` (the same pattern
 * `docker-entrypoint.sh` uses in its own throwaway container filesystem).
 * Hans's review named the damage class that opens here that the pre-fix
 * code could not: `npm i prisma@... -D` is the slow step, a SIGINT during
 * it hits the whole foreground process group including this one, Node exits
 * on an unhandled `SIGINT` without running a pending `finally`, and the
 * *tracked* schema file is left permanently mutated -- a `git diff` nobody
 * asked for, silently feeding the wrong provider into the next `migrate` or
 * commit.
 *
 * The actual fix for (1) only ever needed an ancestor `package.json`
 * findable from the `--schema` path, not the real file's exact location --
 * so the schema copy moves to `localTmpRoot`
 * (`backendRoot/.prisma-workspaces.tmp/`, already used as `migrate`'s own
 * local fallback root) instead of `os.tmpdir()`, and `output` is rewritten
 * to an absolute path. Production callers use the real
 * `backendRoot/src/generated/client`; tests that exercise generation supply
 * a private output directory because Prisma recreates its output
 * non-atomically. `schemaFile` itself is only ever read here, never written -- a SIGINT at
 * any point now loses at most a stray directory under
 * `.prisma-workspaces.tmp/`, the same disposable-workspace risk `migrate`
 * already carries, never a mutated tracked file.
 */
const runPrismaGenerate = (args, options = {}) => {
  const env = {
    ...process.env,
    ...(options.env || {}),
  };
  const provider = inferProvider(env);
  env.DATABASE_PROVIDER = provider;
  env.DATABASE_URL = normalizeDatabaseUrl(env.DATABASE_URL);

  // Production callers keep the real generated client. Tests that exercise
  // generation must supply an isolated output directory: Prisma recreates
  // its output non-atomically, so the shared client cannot be regenerated
  // while unrelated suites import it.
  const outputDir = path.resolve(
    options.generatedClientOutputDir || path.join(backendRoot, "src", "generated", "client"),
  );
  fs.mkdirSync(localTmpRoot, { recursive: true });
  const workspaceDir = fs.mkdtempSync(path.join(localTmpRoot, "generate-"));
  const workspaceSchema = path.join(workspaceDir, "schema.prisma");

  try {
    const schemaWithProvider = rewriteSchemaProvider(
      fs.readFileSync(schemaFile, "utf8"),
      provider
    );
    fs.writeFileSync(workspaceSchema, rewriteGeneratorOutput(schemaWithProvider, outputDir));

    return execFileSync(npxBin, ["prisma", ...withSchemaArg(args, workspaceSchema)], {
      cwd: backendRoot,
      env,
      stdio: options.stdio || "inherit",
      encoding: options.encoding,
    });
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    try {
      fs.rmdirSync(localTmpRoot);
    } catch {
      // Another provider-prisma process may still be using the shared local temp root.
    }
  }
};

const runPrisma = (args, options = {}) => {
  if (args[0] === "generate") return runPrismaGenerate(args, options);

  const env = {
    ...process.env,
    ...(options.env || {}),
  };
  const provider = inferProvider(env);
  env.DATABASE_PROVIDER = provider;
  env.DATABASE_URL = normalizeDatabaseUrl(env.DATABASE_URL);

  const workspace = createProviderWorkspace(provider);
  try {
    const result = execFileSync(
      npxBin,
      ["prisma", ...withSchemaArg(args, workspace.schema)],
      {
        cwd: backendRoot,
        env,
        stdio: options.stdio || "inherit",
        encoding: options.encoding,
      }
    );

    if (options.persistProviderMigrations) {
      persistProviderMigrations(workspace);
    }

    return result;
  } finally {
    fs.rmSync(workspace.dir, { recursive: true, force: true });
    if (workspace.tempRoot === localTmpRoot) {
      try {
        fs.rmdirSync(localTmpRoot);
      } catch {
        // Another provider-prisma process may still be using the shared local temp root.
      }
    }
  }
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const persistIndex = args.indexOf("--persist-provider-migrations");
  const persistRequested = persistIndex !== -1;
  if (persistRequested) args.splice(persistIndex, 1);

  if (args.length === 0) {
    console.error("Usage: provider-prisma.cjs [--persist-provider-migrations] <prisma args...>");
    process.exit(1);
  }

  runPrisma(args, { persistProviderMigrations: persistRequested });
}

module.exports = {
  inferProvider,
  normalizeDatabaseUrl,
  runPrisma,
  rewriteSchemaProvider,
};
