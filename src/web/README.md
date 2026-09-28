# Browser client

`main.js` is the startup entry: it installs global listeners, restores the
session and starts navigation. Feature modules declare their behavior without
mounting UI during import. `state.js` holds the shared session and mounted-view
hooks. `navigation.js` clears these hooks when replacing a view.

`project.js` assembles a project workspace. Its `project/` factories own feature
behavior (composer, explorer, terminal, queue, orchestra, observatory, etc.).
They receive live accessors to this particular mount's state and callbacks;
do not replace these with a copy of the values or a global current-project
lookup. Async callbacks must retain their original recipient. Screenshot
attachments use the mounted composer identity to discard stale results.

`connection.js` owns HTTP/WebSocket helpers; `transcript.js` renders events;
`shell.js` owns the desktop shell; `home.js` owns the project list. Other modules
are named for their UI feature. Dependencies are explicit ES imports. Some
feature dependencies are cyclic, so keep startup effects in `main.js` and
avoid calling imported feature functions during module initialization.

`app.css` lists CSS layers in their original cascade order. `shell.html` contains
the static document and placeholders. Run `npm run build:web` after editing
browser sources (or `npm run build` for the entire project). `npm run dev`
rebuilds the browser before starting. There is no watch pipeline yet.

The build writes `dist/web/app.js`, `app.css`, `shell.html`, and a JS source map.
`daemon/app-page.ts` assembles them into one offline page. Assets ship with the
CLI and desktop daemon; no separate web server, CDN, or runtime bundler is
needed. Source imports of APP_HTML also require these generated assets.

Build before running `npx vitest run --no-file-parallelism test/app-*dom.test.ts`.
These tests execute the actual bundled page in jsdom against local fake agents
and servers. `test/app-page.test.ts` checks document contracts and selected
source helpers. No framework migration is part of this extraction.
