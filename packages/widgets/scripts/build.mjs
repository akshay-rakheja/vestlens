// Builds every src/widgets/<name>/index.html into dist/<name>.html (self-contained).
import { build } from "vite";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = (await readdir(resolve(root, "src/widgets"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(resolve(root, "dist"), { recursive: true });
for (const name of names) {
  process.env.WIDGET = name;
  await build({ configFile: resolve(root, "vite.config.ts"), logLevel: "warn" });
  await copyFile(resolve(root, "dist/.tmp", name, "index.html"), resolve(root, "dist", `${name}.html`));
}
await rm(resolve(root, "dist/.tmp"), { recursive: true, force: true });
// Brand fonts: the widget stylesheets name them as fonts/<file>, which the app serves at /widgets/fonts/<file>.
await mkdir(resolve(root, "dist/fonts"), { recursive: true });
for (const file of (await readdir(resolve(root, "fonts"))).filter((f) => f.endsWith(".woff2"))) {
  await copyFile(resolve(root, "fonts", file), resolve(root, "dist/fonts", file));
}
console.log(`built ${names.length} widget(s): ${names.join(", ")}`);
