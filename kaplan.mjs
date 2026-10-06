// Kaplan'ı tek başına çalıştır: node kaplan.mjs [--no-ai]
// (refresh-cloud.mjs her koşunun sonunda da çağırır.)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runKaplan } from "./lib/kaplan.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
await runKaplan(dir, { ai: !process.argv.includes("--no-ai") });
