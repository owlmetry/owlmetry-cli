#!/usr/bin/env tsx
/**
 * Refresh src/shared/ from a sibling checkout of owlmetry/owlmetry.
 *
 * Run: `npm run sync-shared`
 *
 * Expects ../owlmetry/packages/shared/src/ to exist relative to this repo.
 * Excludes crypto.ts (server-internal) and the __tests__ directory.
 * Prepends an AUTO-GENERATED header to every file so hand-edits are obvious.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SOURCE_DIR = resolve(REPO_ROOT, "../owlmetry/packages/shared/src");
const TARGET_DIR = join(REPO_ROOT, "src/shared");

const HEADER =
  "// AUTO-GENERATED FROM owlmetry/packages/shared — run `npm run sync-shared` to refresh, do not edit by hand.\n\n";

const EXCLUDE_FILES = new Set(["crypto.ts"]);

function assertSourceExists(): void {
  try {
    const stat = statSync(SOURCE_DIR);
    if (!stat.isDirectory()) {
      throw new Error(`${SOURCE_DIR} is not a directory`);
    }
  } catch {
    console.error(
      `error: monorepo not found at ${SOURCE_DIR}\n` +
        `clone owlmetry/owlmetry alongside this repo (so they share a parent directory) and try again.`,
    );
    process.exit(1);
  }
}

function main(): void {
  assertSourceExists();

  const entries = readdirSync(SOURCE_DIR, { withFileTypes: true });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (EXCLUDE_FILES.has(entry.name)) continue;

    const srcPath = join(SOURCE_DIR, entry.name);
    const dstPath = join(TARGET_DIR, entry.name);
    let body = readFileSync(srcPath, "utf8");

    // index.ts: drop the crypto re-export so this remains a clean barrel.
    if (entry.name === "index.ts") {
      body = body
        .split("\n")
        .filter((line) => !/export \* from "\.\/crypto\.js";?/.test(line))
        .join("\n");
    }

    writeFileSync(dstPath, HEADER + body);
    copied += 1;
  }

  console.log(`synced ${copied} files from ${SOURCE_DIR} → ${TARGET_DIR}`);
  console.log(`run \`npm test\` to verify nothing drifted.`);
}

main();
