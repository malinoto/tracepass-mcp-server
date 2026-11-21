import { standard, restrictedSyntaxExceptClientIp } from "@tracepass/code-standard/eslint";

// The shared TracePass coding standard. src/api-client.ts holds the one helper that reads
// the client-address header (clientIpOf); it and the tests that assert the forwarded header
// are the only files exempt from that rule.
export default [
  ...standard,
  {
    files: ["src/api-client.ts", "tests/**/*.ts"],
    rules: { "no-restricted-syntax": restrictedSyntaxExceptClientIp },
  },
];
