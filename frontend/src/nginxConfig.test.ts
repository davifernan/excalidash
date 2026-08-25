import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("production nginx upload limits", () => {
  it("streams every backend-limited upload without a second nginx ceiling", async () => {
    const config = await readFile(resolve(process.cwd(), "nginx.conf.template"), "utf8");
    const exactLocationBody = (path: string) =>
      config.match(
        new RegExp(`location = ${path.replaceAll("/", "\\/")} \\{([\\s\\S]*?)\\n        \\}`),
      )?.[1] ?? "";

    const uploadPaths = [
      "/api/import/excalidash",
      "/api/import/excalidash/verify",
      "/api/import/sqlite/legacy",
      "/api/import/sqlite/legacy/verify",
    ];
    const assertStreaming = (body: string) => {
      expect(body).toContain("client_max_body_size 0;");
      expect(body).toContain("proxy_request_buffering off;");
    };

    expect(config).toContain("client_max_body_size 50M;");
    for (const path of uploadPaths) assertStreaming(exactLocationBody(path));

    const assetMarker = "location ~ ^/api/drawings/[^/]+/assets$ {";
    const assetStart = config.indexOf(assetMarker);
    const assetEnd = config.indexOf("\n        }", assetStart);
    const assetLocation =
      assetStart >= 0 && assetEnd > assetStart ? config.slice(assetStart, assetEnd) : "";
    assertStreaming(assetLocation);
    expect(config).not.toContain("client_max_body_size 2301M;");
    expect(config.match(/client_max_body_size 0;/g)).toHaveLength(5);
    expect(config.match(/proxy_request_buffering off;/g)).toHaveLength(5);
  });

  it("builds and validates only the tested nginx template", async () => {
    const [dockerfile, entrypoint] = await Promise.all([
      readFile(resolve(process.cwd(), "Dockerfile"), "utf8"),
      readFile(resolve(process.cwd(), "docker-entrypoint.sh"), "utf8"),
    ]);

    expect(dockerfile).toContain(
      "COPY frontend/nginx.conf.template /etc/nginx/nginx.conf.template",
    );
    expect(dockerfile).not.toMatch(/COPY frontend\/nginx\.conf\s/);
    expect(entrypoint).toContain("/etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf");
    expect(entrypoint).toContain("nginx -t -c /etc/nginx/nginx.conf");
    await expect(access(resolve(process.cwd(), "nginx.conf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes the opt-in tracker DSN into runtime config without allowing script injection", async () => {
    const [entrypoint, index] = await Promise.all([
      readFile(resolve(process.cwd(), "docker-entrypoint.sh"), "utf8"),
      readFile(resolve(process.cwd(), "index.html"), "utf8"),
    ]);

    expect(index).toContain('<script src="/runtime-config.js"></script>');
    expect(entrypoint).toContain('export ERROR_TRACKER_DSN="${ERROR_TRACKER_DSN:-}"');
    expect(entrypoint).toContain("ERROR_TRACKER_DSN contains characters");
    expect(entrypoint).toContain("> /usr/share/nginx/html/runtime-config.js");

    const config = await readFile(resolve(process.cwd(), "nginx.conf.template"), "utf8");
    const runtimeLocation = config.match(
      /location = \/runtime-config\.js \{([\s\S]*?)\n {8}\}/,
    )?.[1];
    expect(runtimeLocation).toContain('Cache-Control "no-store');
    expect(runtimeLocation).toContain("expires -1;");
  });

  it.each(['"', "<", "\\", " "])(
    "executes the entrypoint guard and rejects injection character %j",
    (errorTrackerDsn) => {
      const entrypoint = resolve(process.cwd(), "docker-entrypoint.sh");
      const result = spawnSync("/bin/sh", [entrypoint, "true"], {
        encoding: "utf8",
        env: {
          ...process.env,
          BACKEND_URL: "backend:8000",
          ERROR_TRACKER_DSN: errorTrackerDsn,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe(
        "ERROR: ERROR_TRACKER_DSN contains characters that are not valid in a DSN URL",
      );
      expect(result.stdout).not.toContain("Validating nginx configuration");
    },
  );
});
