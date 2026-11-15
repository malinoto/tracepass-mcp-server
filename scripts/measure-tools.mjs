#!/usr/bin/env node
/**
 * Prints the byte size of every tool in the main server's `tools/list`
 * response, and the total. Builds the list the way a client receives it: a real
 * MCP client against `createMcpServer` over an in-memory transport, so the SDK's
 * JSON-Schema conversion is included. Needs `npm run build` first.
 *
 *   npm run measure:tools            # table
 *   npm run measure:tools -- --check # exit 1 when over the budget
 *   npm run measure:tools -- --contract > tests/fixtures/tools-contract.json
 *       # the list with every description removed: names, titles, annotations,
 *       # input/output schemas. Locks what clients and the n8n node depend on.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server.js";

const BUDGET_BYTES = 28_000; // keep equal to tests/tools-list-size.test.ts

const server = createMcpServer({ baseUrl: "https://example.invalid", apiKey: "tp_measure" });
const client = new Client({ name: "measure-tools", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const { tools } = await client.listTools();

if (process.argv.includes("--contract")) {
  const strip = (v) =>
    Array.isArray(v)
      ? v.map(strip)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k, x]) => !(k === "description" && typeof x === "string"))
              .map(([k, x]) => [k, strip(x)]),
          )
        : v;
  const contract = tools.map((t) => ({
    ...t,
    description: undefined,
    inputSchema: strip(t.inputSchema),
    outputSchema: strip(t.outputSchema),
  }));
  console.log(JSON.stringify(contract, null, 1));
  await client.close();
  process.exit(0);
}

const size = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");
let total = 0;
for (const t of tools) {
  const n = size(t);
  total += n;
  const desc = Buffer.byteLength(t.description ?? "", "utf8");
  console.log(`${t.name.padEnd(32)} ${String(n).padStart(7)} B  (description ${desc} B)`);
}
console.log(`${"TOTAL".padEnd(32)} ${String(total).padStart(7)} B  ${tools.length} tools`);
await client.close();
if (process.argv.includes("--check") && total > BUDGET_BYTES) {
  console.error(`over budget: ${total} > ${BUDGET_BYTES}`);
  process.exit(1);
}
