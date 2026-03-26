/**
 * Assignment entry point — Gmail + Calendar PASS/FAIL suite.
 *
 * Bun loads `.env` from this project folder automatically.
 *
 * Run: bun run test:assignment
 *     (or: bun src/index.ts)
 */
import { runAssignmentSuite } from "./agent";

await runAssignmentSuite();
