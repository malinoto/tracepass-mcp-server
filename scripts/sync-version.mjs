/**
 * Writes the version from `package.json` into every other place it is stated.
 *
 * `package.json` is the npm source of truth. The same version is also written in
 * `server.json` (the top-level `version` AND `packages[0].version`, read by the MCP
 * Registry) and in `src/server.ts` (`MCP_SERVER_INFO`, what the live endpoint
 * reports). Bumping those by hand is how copies drift; `tests/version-lockstep.test.ts`
 * catches a miss, and this script removes the chance of one.
 *
 * It runs as npm's `version` lifecycle hook, so
 *
 *   npm version patch|minor|major
 *
 * bumps package.json, runs this, stages the files it changed and commits them all in
 * the one release commit. The www mirror of the server card lives in the marketing
 * repo, so it cannot join that commit: when the sibling checkout exists this script
 * regenerates it (via build:server-card) and says so; commit it there.
 *
 *   node scripts/sync-version.mjs [--root <dir>] [--no-card]
 *
 * `--root` points at another copy of the repo (used by the tests); `--no-card` skips
 * the mirror regeneration.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const root = rootArg >= 0 ? args[rootArg + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
const withCard = !args.includes("--no-card");

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`sync-version: package.json version "${version}" is not semver`);
  process.exit(1);
}

const changed = [];

// server.json — both spots, edited as JSON so the key order and indentation stay.
const serverJsonPath = join(root, "server.json");
const serverJsonRaw = readFileSync(serverJsonPath, "utf8");
const serverJson = JSON.parse(serverJsonRaw);
serverJson.version = version;
if (!Array.isArray(serverJson.packages) || serverJson.packages.length === 0) {
  console.error("sync-version: server.json has no packages[] entry to version");
  process.exit(1);
}
for (const p of serverJson.packages) p.version = version;
const serverJsonOut = JSON.stringify(serverJson, null, 2) + (serverJsonRaw.endsWith("\n") ? "\n" : "");
if (serverJsonOut !== serverJsonRaw) {
  writeFileSync(serverJsonPath, serverJsonOut);
  changed.push("server.json");
}

// src/server.ts — the single literal inside MCP_SERVER_INFO.
const serverTsPath = join(root, "src", "server.ts");
const serverTs = readFileSync(serverTsPath, "utf8");
const block = /(export const MCP_SERVER_INFO = \{[^}]*?version:\s*")([^"]+)(")/;
if (!block.test(serverTs)) {
  console.error("sync-version: could not find MCP_SERVER_INFO.version in src/server.ts");
  process.exit(1);
}
const serverTsOut = serverTs.replace(block, `$1${version}$3`);
if (serverTsOut !== serverTs) {
  writeFileSync(serverTsPath, serverTsOut);
  changed.push("src/server.ts");
}

console.log(`sync-version: ${version} → ${changed.length ? changed.join(", ") : "already in step"}`);

// Stage what changed so `npm version` puts it in the release commit. Only inside a
// real `npm version` run in this repo (npm sets npm_lifecycle_event), never for --root.
if (process.env.npm_lifecycle_event === "version" && rootArg < 0 && changed.length) {
  execSync(`git add ${changed.join(" ")}`, { cwd: root, stdio: "inherit" });
}

// The www mirror (another repository): regenerate when the sibling checkout exists.
if (withCard && rootArg < 0) {
  try {
    execSync("npm run --silent build:server-card", { cwd: root, stdio: "inherit" });
    console.log("sync-version: regenerated the www server-card mirror — commit it in the marketing repo.");
  } catch {
    // Not fatal: the mirror lives in another repo and must not block this release.
    // tests/version-lockstep.test.ts fails loudly while the mirror is stale.
    console.error("sync-version: WARNING — server-card regeneration failed; run `npm run build:server-card` and commit the mirror in the marketing repo.");
  }
}
