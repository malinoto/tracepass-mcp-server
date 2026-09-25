/**
 * Generates the marketing site's static copy of the MCP server card from
 * `SERVER_CARD` in src/http.ts — the object the live `ai.tracepass.eu` endpoint
 * actually serves.
 *
 * WHY THE MIRROR EXISTS: scanners (isitagentready.com among them) canonicalize
 * `ai.tracepass.eu` to its redirect target (www) and probe only there, so the
 * card must also be reachable as a static file on the marketing site.
 *
 * WHY IT IS GENERATED: it was a hand-maintained byte-copy in a DIFFERENT
 * REPOSITORY, so a release had to remember to update it. The nested
 * `serverInfo.version` was the copy that got missed — two levels down in a file
 * whose top-level `version` is the one usually edited, with the drift visible
 * only by diffing the served card against the live endpoint. Generating it
 * removes the duplication rather than policing it.
 *
 * `tests/version-lockstep.test.ts` still asserts the two agree. Keep both: the
 * generator prevents drift when it runs, the test catches a hand-edit of the www
 * file or a release that forgot to run it.
 *
 * Reads from `dist/` (hence the npm scripts build first) so there is no
 * TypeScript loader dependency — this package ships only `@modelcontextprotocol/sdk`
 * and `zod`, and adding tsx just to run one script is not worth it.
 *
 *   npm run build:server-card     # write the mirror
 *   npm run check:server-card     # verify only, exit 1 on drift
 *
 * The marketing repo must be a sibling checkout; both modes exit 0 with a notice
 * when it is not, so this runs safely where only this repo is present.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVER_CARD } from '../dist/http.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TARGET = join(ROOT, '..', 'tracepass', 'public', '.well-known', 'mcp', 'server-card.json');

const checkOnly = process.argv.includes('--check');

// Two-space indent + trailing newline: matches the committed file, so a
// regeneration produces no spurious diff.
const rendered = `${JSON.stringify(SERVER_CARD, null, 2)}\n`;

if (!existsSync(dirname(TARGET))) {
	console.log('· marketing repo is not a sibling checkout — skipping');
	process.exit(0);
}

if (checkOnly) {
	if (!existsSync(TARGET)) {
		console.error(`✗ ${TARGET} is missing. Run: npm run build:server-card`);
		process.exit(1);
	}
	if (readFileSync(TARGET, 'utf8') !== rendered) {
		console.error(
			'✗ the published server card has drifted from SERVER_CARD in src/http.ts.\n' +
				'  Regenerate it, then commit in the marketing repo:\n' +
				'    npm run build:server-card',
		);
		process.exit(1);
	}
	console.log('✓ published server card matches SERVER_CARD');
	process.exit(0);
}

mkdirSync(dirname(TARGET), { recursive: true });
writeFileSync(TARGET, rendered, 'utf8');
console.log(`✓ wrote ${TARGET}`);
console.log('  Commit it in the marketing repo — a push to main publishes.');
// Importing dist/http.js starts its listener, so exit explicitly (as the
// other branches do) or the script never ends.
process.exit(0);
