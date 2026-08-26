import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const readRootFile = (name: string) => readFile(resolve(root, name), "utf8");

describe("production operations defaults", () => {
  it("enables bounded scheduled backups on persistent host storage", async () => {
    const compose = await readRootFile("docker-compose.prod.yml");
    expect(compose).toMatch(/BACKUP_SCHEDULE=.*0 0 3 \* \* \*/);
    expect(compose).toMatch(/BACKUP_MAX_COUNT=.*7/);
    expect(compose).toMatch(/BACKUP_MAX_TOTAL_MB=.*30720/);
    expect(compose).toMatch(/BACKUP_MIN_FREE_DISK_PERCENT=.*20/);
    expect(compose).toMatch(/BACKUP_HOST_DIR[^\n]*:\/app\/backups/);
  });

  it("rotates container logs in every dev/lab/test compose file", async () => {
    // Short-lived by design: these environments get torn down and rebuilt
    // constantly, so a rotating few-hour window is the right size for them.
    // Only docker-compose.prod.yml runs unattended long enough that its logs
    // need to outlive that window (NIL-619) -- checked separately below.
    const names = [
      "docker-compose.yml",
      "docker-compose.lab.yml",
      "docker-compose.local-multi.yml",
      "docker-compose.oidc.yml",
      "docker-compose.pg-test.yml",
    ];
    for (const name of names) {
      const compose = await readRootFile(name);
      expect(compose, name).toContain('max-size: "10m"');
      expect(compose, name).toContain('max-file: "3"');
    }
  });

  it("retains and compresses production container logs for at least a week (NIL-619)", async () => {
    // Measured on the running production containers, 26.08.2026 (see
    // docker-compose.prod.yml's inline comment for the full numbers): a
    // quiet-day backend rate of ~8 KB/day would already outlast a week at
    // the old 30 MB/container cap -- the real failure was a rare event
    // firing once and rotating away before anyone looked, not steady volume
    // exceeding the cap. max-file: 20 (200 MB/container) leaves roughly
    // 1000x that quiet-day rate of headroom per week, and compress: true
    // gzips every rotated segment (measured ~3.4x on backend JSON lines,
    // ~11x on frontend's repetitive access-log lines) at zero extra memory --
    // no separate collector, since this machine was already at 7.2/8 GB swap
    // used during the same measurement.
    const compose = await readRootFile("docker-compose.prod.yml");
    expect(compose).toContain('max-size: "10m"');
    expect(compose).toContain('max-file: "20"');
    expect(compose).toContain('compress: "true"');
    // The old 3-file cap must be gone, not merely outnumbered by a stray match.
    expect(compose).not.toContain('max-file: "3"');
  });

  it("requires an explicit immutable production image tag", async () => {
    const compose = await readRootFile("docker-compose.prod.yml");
    expect(compose).not.toMatch(/excalidash-(?:backend|frontend):latest/);
    expect(compose).toMatch(/EXCALIDASH_IMAGE_TAG:\?[^}]+/);
  });

  it("ships a disaster restore and interrupted-upgrade runbook", async () => {
    const restore = await readRootFile("docs/RESTORE.md");
    expect(restore).toContain("database.sqlite");
    expect(restore).toContain("assets/originals");
    expect(restore).toContain(".jwt_secret");
    expect(restore).toContain(".csrf_secret");
    expect(restore).toMatch(/Expected result:/g);
    expect(restore).toContain(".migration-lock");
    expect(restore).toContain("prisma migrate resolve");
  });
});
