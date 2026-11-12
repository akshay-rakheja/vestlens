// The Docker web build copies only packages/web and installs only its dependencies, then runs `tsc -b`
// over src (tests included). A web source or test that imports Node built-ins, uses __dirname, or reaches into
// another package passes locally but breaks the deploy build. This guard fails fast instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../packages/web/src/", import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name)) files.push(p);
  }
})(root);

test("web sources and tests stay buildable in isolation", () => {
  const offenders = [];
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    if (/from\s+["']node:|require\(["']node:|\b__dirname\b|["'](\.\.\/)+(api|widgets)\//.test(s)) offenders.push(f.slice(root.length));
  }
  assert.deepEqual(offenders, [], `Node imports, __dirname or cross-package paths in packages/web/src: ${offenders.join(", ")}`);
});

test("the vite config stays buildable in isolation", () => {
  const config = readFileSync(new URL("../packages/web/vite.config.ts", import.meta.url), "utf8");
  assert.doesNotMatch(config, /from\s+["']node:/, "tsc -b typechecks vite.config.ts, and the Docker web build has no Node types");
});

test("a local TypeScript build cache can't hide errors from the deploy build", () => {
  for (const file of [".dockerignore"]) {
    assert.match(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), /^\*\*\/\*\.tsbuildinfo$/m, file);
  }
});
