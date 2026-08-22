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
});
