/** Build the offline browser client. No runtime bundler or CDN is required. */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = new URL('../dist/web/', import.meta.url);
await fs.mkdir(out, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/web/main.js'],
  outfile: fileURLToPath(new URL('app.js', out)),
  bundle: true,
  format: 'iife',
  target: 'es2022',
  // Keep names and readable output for local debugging and transcript errors.
  minify: false,
  keepNames: true,
  sourcemap: 'external',
  legalComments: 'inline',
});
const styleEntry = new URL('../src/web/app.css', import.meta.url);
const imports = [...(await fs.readFile(styleEntry, 'utf8')).matchAll(/@import "([^"]+)";/g)];
const styles = await Promise.all(imports.map(([, name]) => fs.readFile(new URL(name, styleEntry), 'utf8')));
await fs.writeFile(new URL('app.css', out), styles.join(''));
await Promise.all(['shell.html'].map(name =>
  fs.copyFile(new URL('../src/web/' + name, import.meta.url), new URL(name, out))));
