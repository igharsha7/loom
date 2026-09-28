/** Daemon-side assembly of the framework-independent browser client. */
import fs from 'node:fs';
import { BRAND_SPRITE } from './brand-icons.js';

// Both src/daemon and dist/daemon resolve this path to the packaged assets.
// Build assets before running from source (npm run dev does this for you).
const asset = (name: string) => fs.readFileSync(new URL('../../dist/web/' + name, import.meta.url), 'utf8');

export const APP_MANIFEST = {
  name: "Loom",
  short_name: "Loom",
  start_url: "/app",
  display: "standalone",
  background_color: "#0a0a0a",
  theme_color: "#0a0a0a",
  icons: [
    {
      src:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%230a0a0a'/%3E%3Ctext x='50' y='60' font-size='36' text-anchor='middle' fill='%23fafafa' font-family='-apple-system,Segoe UI,sans-serif' font-weight='600'%3Elo%3C/text%3E%3Crect x='32' y='70' width='36' height='4' rx='2' fill='%2367e8f9'/%3E%3C/svg%3E",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
  ],
};

export const APP_HTML = asset('shell.html')
  .replace('%%APP_CSS%%', () => asset('app.css'))
  .replace('%%BRAND_SPRITE%%', () => BRAND_SPRITE)
  .replace('%%APP_JS%%', () => asset('app.js'));
