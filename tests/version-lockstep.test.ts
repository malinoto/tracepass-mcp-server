import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_SERVER_INFO } from "../src/server.js";

/**
 * The server version is hand-written in SIX places across FOUR files, in TWO
 * repositories. Nothing generates any of them, so a release bumps them by hand
 * and a miss is silent: the endpoint keeps reporting the old version while
 * serving new code, which makes a correct deploy look like a failed one.
 *
 * `package.json` is treated as the source of truth here — it is the version npm
 * actually publishes.
 *
 * The one that gets missed is the NESTED `serverInfo.version` in the marketing
 * repo's `.well-known/mcp/server-card.json`: it sits two levels down in a file
 * whose top-level `version` is usually the one edited, it lives in a different
 * repository from the code it describes, and the drift is only visible by
 * diffing the served card against the live endpoint. So this test reaches
 * across the repo boundary when the sibling checkout is present, and skips
 * cleanly when it is not (CI clones this repo alone).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const pkg = readJson(join(ROOT, "package.json"));
const SOURCE_OF_TRUTH = String(pkg.version);

describe("server version is in lockstep across every copy", () => {
  it("package.json carries a plain semver", () => {
    expect(SOURCE_OF_TRUTH).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("MCP_SERVER_INFO.version matches package.json", () => {
    // This is what the running server reports over the protocol, and what the
    // /mcp endpoint echoes back — the value a client actually observes.
    expect(MCP_SERVER_INFO.version).toBe(SOURCE_OF_TRUTH);
  });

  it("server.json matches package.json, at both levels", () => {
    const serverJson = readJson(join(ROOT, "server.json"));
    expect(serverJson.version).toBe(SOURCE_OF_TRUTH);

    // The registry entry repeats the version inside packages[] — a second copy
    // in the same file, easy to leave behind when only the top one is edited.
    const packages = serverJson.packages as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(packages)).toBe(true);
    for (const p of packages ?? []) {
      expect(p.version).toBe(SOURCE_OF_TRUTH);
    }
  });

  it("the published server card matches — including the NESTED serverInfo.version", () => {
    // Cross-repo: only checkable when the marketing repo is a sibling checkout.
    const card = join(
      ROOT,
      "..",
      "tracepass",
      "public",
      ".well-known",
      "mcp",
      "server-card.json",
    );
    if (!existsSync(card)) {
      // Not a failure: CI clones this repo alone. The check is a local/dev
      // guard, and the publish flow is where both repos are present.
      return;
    }

    const served = readJson(card);
    expect(served.version, "server-card.json top-level version").toBe(SOURCE_OF_TRUTH);

    const serverInfo = served.serverInfo as Record<string, unknown> | undefined;
    expect(serverInfo, "server-card.json serverInfo block").toBeTruthy();
    expect(
      serverInfo?.version,
      "server-card.json serverInfo.version — the copy that is missed most often",
    ).toBe(SOURCE_OF_TRUTH);
  });
});
