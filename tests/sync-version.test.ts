/**
 * `npm version` runs scripts/sync-version.mjs, which must carry the new version
 * from package.json into every other place it is written. Runs the real script
 * against a temporary copy of the repo.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const repo = join(__dirname, "..");

function withCopy(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-version-"));
  try {
    mkdirSync(join(dir, "src"));
    for (const f of ["package.json", "server.json", join("src", "server.ts")]) copyFileSync(join(repo, f), join(dir, f));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const run = (dir: string) =>
  execFileSync(process.execPath, [join(repo, "scripts", "sync-version.mjs"), "--root", dir, "--no-card"], { encoding: "utf8" });

describe("sync-version", () => {
  it("writes the package.json version into server.json (both spots) and MCP_SERVER_INFO", () => {
    withCopy((dir) => {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      pkg.version = "9.8.7";
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
      run(dir);
      const server = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));
      expect(server.version).toBe("9.8.7");
      expect(server.packages.map((p: { version: string }) => p.version)).toEqual(server.packages.map(() => "9.8.7"));
      expect(readFileSync(join(dir, "src", "server.ts"), "utf8")).toMatch(/MCP_SERVER_INFO = \{[^}]*version: "9\.8\.7"/);
    });
  });

  it("is a no-op when everything is already in step", () => {
    withCopy((dir) => {
      const before = readFileSync(join(dir, "server.json"), "utf8");
      expect(run(dir)).toContain("already in step");
      expect(readFileSync(join(dir, "server.json"), "utf8")).toBe(before);
    });
  });
});
