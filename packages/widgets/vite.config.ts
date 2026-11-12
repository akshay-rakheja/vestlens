import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve } from "node:path";

// One build per widget: WIDGET=<name> selects src/widgets/<name>/index.html.
const widget = process.env.WIDGET ?? "overview";
export default defineConfig({
  root: resolve(__dirname, "src/widgets", widget),
  plugins: [preact(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: resolve(__dirname, "dist/.tmp", widget),
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: false,
  },
});
