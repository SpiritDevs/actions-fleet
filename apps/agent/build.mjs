import { build } from "esbuild";
import { chmod } from "node:fs/promises";

await build({
  entryPoints: ["src/cli.ts"], bundle: true, platform: "node", format: "esm",
  target: "node22.14", outfile: "dist/cli.js", sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
await chmod("dist/cli.js", 0o755);
