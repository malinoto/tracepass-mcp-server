import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The MCP Registry refuses a server description longer than 100 characters
 * (422 at publish time), and nothing else checks it: `npm version` and the npm
 * publish both succeed, so the limit only shows once the release is half shipped.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_FILES = ["server.json", "server.compliance.json"];

describe("registry files", () => {
  for (const file of REGISTRY_FILES) {
    it(`${file} has a description the registry accepts (at most 100 characters)`, () => {
      const { description } = JSON.parse(readFileSync(join(root, file), "utf8"));
      expect(typeof description).toBe("string");
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(100);
    });
  }
});
