# Vite 7 + Tailwind 3 + PostCSS + html-to-image

> Front-end build pipeline and PNG export engine for the Chat Aggregator operator UI. Pinned: **vite ^7.3.1** · **tailwindcss ^3.4.4** · **postcss ^8.4.38** · **autoprefixer ^10.4.19** · **html-to-image ^1.11.13**

---

## How we use it

### Build pipeline (Vite + PostCSS + Tailwind)

`client/` is a standalone Vite project (`"type": "module"`, `client/package.json`). The root `package.json` has two entry points that matter for CI/production:

```
"build":       "cd client && npm install --include=dev && npm run build"
"postinstall": "npm run build"
```

**`postinstall` is the production build trigger.** On Railway (Nixpacks builder, `railway.json`), `npm install` on the root package runs first, which fires `postinstall`, which installs client devDeps (Vite, Tailwind, PostCSS, autoprefixer) and then calls `vite build`. The resulting `client/dist/` is the static bundle served at runtime.

In production, Express serves it (`src/server/index.js:585-589`):

```js
app.use(express.static(join(__dirname, '../../client/dist')));
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../../client/dist/index.html'));
});
```

The `'*'` catch-all enables client-side routing (React Router). This is only registered when `NODE_ENV === 'production'`; in dev, the Vite dev server at `:5173` handles it.

### Dev server proxy (`client/vite.config.js:6-21`)

Three proxy rules forward requests from `:5173` to Express at `:3001`:

| Path | Target | Options |
|---|---|---|
| `/socket.io` | `http://localhost:3001` | `ws: true` — WebSocket upgrade passthrough |
| `/api` | `http://localhost:3001` | `changeOrigin: true` |
| `/webhook` | `http://localhost:3001` | `changeOrigin: true` |

`ws: true` is required for Socket.io. Without it, the WebSocket upgrade from `:5173` would not reach the server.

### Tailwind setup

`client/src/index.css:1-3` uses the three standard directives:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`client/tailwind.config.js` scans:
```js
content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"]
```

`client/postcss.config.js` wires Tailwind and Autoprefixer as PostCSS plugins. Vite invokes PostCSS automatically during both dev (via `@vitejs/plugin-react`) and `vite build`.

### html-to-image — PNG quote-card export

`SavedPanel.jsx` renders a `QuoteCard` (1080×1080 px, fully inline-styled) into an off-screen fixed slot (`left: -20000px, zIndex: -1`) and passes the ref to `toPng`. The call site (`SavedPanel.jsx:44-48`):

```js
const dataUrl = await toPng(cardRef.current, {
  pixelRatio: 2,           // final PNG is 2160×2160
  cacheBust: true,
  backgroundColor: '#0f0f23',
});
```

Two nested `requestAnimationFrame` calls (`SavedPanel.jsx:39-40`) ensure the React render and browser layout both commit before the snapshot fires:

```js
await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
```

After `toPng` returns a data URL, the code converts it to a Blob URL (`fetch(dataUrl).blob()` → `URL.createObjectURL(blob)`) specifically to support WKWebView in the Mac launcher. WKWebView's `WKDownloadDelegate` can intercept blob navigation; raw `data:` URL anchor clicks are silently dropped in that WebView context. The anchor is added to `document.body`, clicked, then removed; `URL.revokeObjectURL` fires after a 2-second delay to allow the download to start (`SavedPanel.jsx:56-74`).

`QuoteCard.jsx` uses **no Tailwind classes and no external stylesheets** — every style is inline. This is deliberate: html-to-image's SVG `<foreignObject>` serialization path does not reliably resolve stylesheet rules (`client/src/components/QuoteCard.jsx:13-14` comment).

---

## Core concepts

### Vite 7 dev vs build split
- **Dev**: native ESM served directly to the browser; no bundling. HMR via `@vitejs/plugin-react` (fast refresh). PostCSS/Tailwind still run per-file.
- **Build**: Rollup bundles the app (Rolldown available separately as `rolldown-vite` but NOT what our `^7.3.1` pin uses — that still ships Rollup by default). Output lands in `client/dist/` with content-hashed filenames. CSS is extracted and processed through the full PostCSS chain.

### Tailwind JIT (always-on in v3)
Tailwind v3 runs JIT by default. Every build scans the `content` paths with a regex-based extractor and emits only classes that appear as complete, unbroken strings. Dynamic constructions like `` `bg-${color}-500` `` are invisible to the scanner.

### import.meta.env and VITE_ env vars
Vite statically replaces `import.meta.env.VITE_*` at build time — the values are embedded in the JS bundle. `import.meta.env.DEV` and `import.meta.env.PROD` are also replaced. Non-prefixed env vars are never exposed to the client.

`SavedPanel.jsx:6-8` uses `import.meta.env.DEV` to toggle the API base URL:
```js
const API_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;
```

### html-to-image rendering pipeline
1. Clone the target DOM subtree
2. Compute and inline inherited styles on each node
3. Find all `@font-face` rules from `<style>` tags, fetch each font file, base64-encode them into the CSS
4. Fetch and inline images as base64
5. Serialize the clone into an `<svg><foreignObject>…</foreignObject></svg>`
6. Draw it to an `HTMLCanvasElement` via `ctx.drawImage`
7. Export via `canvas.toDataURL()` (for `toPng`) or `canvas.toBlob()` (for `toBlob`)

---

## API / SDK surface we touch

### Vite
| Feature | Our use | Notes |
|---|---|---|
| `defineConfig` | `vite.config.js:4` | Typed config wrapper |
| `server.proxy` | `vite.config.js:8-21` | `/socket.io` (ws), `/api`, `/webhook` → `:3001` |
| `@vitejs/plugin-react` | `vite.config.js:5` | JSX transform + fast refresh |
| `vite build` | `package.json build script` | Output to `client/dist/` |
| `import.meta.env.DEV` | `SavedPanel.jsx:6` | Runtime environment flag |
| `import.meta.env.PROD` | not used directly | Available via `!DEV` |
| `vite preview` | local testing only | Serves `dist/` locally |

NOT used: `build.rolldownOptions`, `build.target` override, `optimizeDeps`, manifest generation, `server.origin`, SSR mode.

### Tailwind CSS v3
| Feature | Our use | Notes |
|---|---|---|
| `@tailwind base/components/utilities` | `index.css:1-3` | All three directives |
| `content` glob | `tailwind.config.js:3-6` | `index.html` + `src/**/*.{js,ts,jsx,tsx}` |
| `theme.extend` | `tailwind.config.js:7-9` | Empty — no custom tokens |
| `plugins` | `tailwind.config.js:10` | Empty — no plugins |
| Utility classes | throughout `src/` | Standard utilities only (spacing, flex, text, opacity, color) |
| CSS variables (`var(--accent-color)`, `var(--text-color)`) | `SavedPanel.jsx:108,125,136,155,161,171,175` | Applied via Tailwind's `style` prop, NOT via config-registered tokens |

NOT used: `safelist`, `blocklist`, `darkMode`, `screens` override, `@apply`, `theme()` function, `@layer` custom components.

### html-to-image
| Method / Option | Our use | Purpose |
|---|---|---|
| `toPng(node, options)` | `SavedPanel.jsx:44` | Renders card DOM to base64 PNG data URL |
| `pixelRatio: 2` | `SavedPanel.jsx:45` | 2× for retina; 1080px card → 2160px PNG |
| `cacheBust: true` | `SavedPanel.jsx:46` | Appends timestamp to image src fetches to bypass browser cache |
| `backgroundColor: '#0f0f23'` | `SavedPanel.jsx:47` | Fills transparent areas (card has `backgroundColor` in inline style too — belt-and-suspenders) |

NOT used: `toBlob` (we do `toPng` then `fetch(dataUrl).blob()`), `toCanvas`, `toSvg`, `toJpeg`, `toPixelData`, `filter`, `width`/`height` override, `fontEmbedCSS` / `getFontEmbedCSS`, `preferredFontFormat`, `skipAutoScale`, `canvasWidth`/`canvasHeight`, `imagePlaceholder`.

---

## Auth & secrets

The build tooling stack has **no secrets**. The client bundle contains no API keys or credentials.

`VITE_*` env vars: **none are defined** in `.env.example` or used in the current codebase. If you add any, remember they are hard-baked into the bundle at build time — treat them as public.

The `SESSION_SECRET`, `RECALL_API_KEY`, `STRIPE_SECRET_KEY`, etc. live only in the server process (`dotenv.config()` in `src/server/index.js:24`) and are never injected into the Vite build.

---

## Webhooks / events

Not applicable to the build tooling layer. (Socket.io events from the server to the client are documented in the `react-frontend.md` and `recall.md` docs.)

---

## Version-specific notes

### Vite 7.x (our pin: `^7.3.1`)
- **Node.js 20.19+ or 22.12+ required.** Node 18 support was dropped (EOL April 2025). Railway's Nixpacks should select Node 20+; verify if you ever change the Node image.
- **ESM-only distribution.** Vite 7 itself is ESM-only. Our `client/package.json` has `"type": "module"` so `vite.config.js` uses ES `import` syntax — this is correct. A `vite.config.cjs` would fail.
- **Default `build.target` changed** from `'modules'` to `'baseline-widely-available'`, raising the floor to Chrome 107, Firefox 104, Safari 16.0. This is fine for our operator-facing app (not a public consumer product).
- **`splitVendorChunkPlugin` removed** in v7. We don't use it so no impact.
- **Sass legacy API removed** in v7. We don't use Sass, no impact.
- **Rolldown is NOT the default** in v7.x. Rolldown becomes the default in Vite 8. Our builds still use Rollup. `build.rollupOptions` is still valid.

### Tailwind 3.x (our pin: `^3.4.4`)
- JIT is the only mode; v2-style `mode: 'jit'` config key is gone.
- Tailwind v3 ships as a PostCSS plugin. Vite's built-in PostCSS support picks it up via `postcss.config.js` automatically, no extra config needed.
- Tailwind v4 (CSS-first config, Lightning CSS) is a completely different product. **Do not upgrade without a full migration.** Our `tailwind.config.js` (JS-based) and `@tailwind` directives are v3 syntax.

### html-to-image 1.11.x (our pin: `^1.11.13`)
- Library is forked from `dom-to-image` and is maintained by `bubkoo`.
- Maintenance has been slow; the repo has open issues but no critical regressions reported for the use case of rendering inline-styled, image-free DOM nodes.
- `getFontEmbedCSS()` (to cache font embedding across multiple calls) was added before 1.11; we don't use it because we only export one card at a time.

---

## Rate limits / quotas / scaling

None for this layer. Vite dev server and `vite build` are local processes. Tailwind's JIT scan is bounded by the size of `src/` (currently small). `html-to-image` runs entirely in the browser — no network calls except font fetching, which only happens when `@font-face` rules reference remote URLs.

QuoteCard uses **system fonts** (`-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif`). html-to-image never makes external font requests for this card, which keeps the export fast and avoids CORS font issues entirely.

---

## Gotchas & failure modes

### 1. `toPng` returns a blurry or mis-sized PNG
html-to-image uses the physical device pixel ratio by default. If `pixelRatio` is not set and the operator is on a 1× display, the output is 1080×1080 px at 72 DPI — technically correct but soft when printed or displayed at 2×. We force `pixelRatio: 2` to always get 2160×2160 output. Do not remove this option.

### 2. QuoteCard text renders in the wrong font
The `fontFamily` in `QuoteCard.jsx:44` lists a stack of system fonts. html-to-image's font embedding only processes `@font-face` rules found in `<style>` tags. Because we use system fonts, there is nothing to embed — the browser renders whatever system font matches first. On a machine without "Inter" installed, it falls back gracefully. If you add a custom webfont, you must either: (a) host it with CORS headers and accept that html-to-image will fetch + base64-encode it on every export, or (b) precompute `getFontEmbedCSS()` and pass it in `fontEmbedCSS`.

### 3. WKWebView silently drops `<a download href="data:...">` clicks
This is why `SavedPanel.jsx:56-74` converts the data URL to a Blob URL first. The WebKit bug (webkit.org #216918) was resolved as "configuration changed" in January 2024 (Safari 17.3+), but our Mac launcher may run an older embedded WebKit. The blob URL path is the correct, cross-version-safe approach for WKWebView. Do not simplify this to a direct `<a href={dataUrl}>` without testing in the actual `.app`.

### 4. One RAF is not enough before snapshotting
React state updates are batched and committed asynchronously. A single `requestAnimationFrame` fires before the browser paints the new frame; a second RAF ensures layout has also finished. The double-RAF pattern in `SavedPanel.jsx:39-40` is deliberate — removing one will cause intermittent "card ref missing" or blank PNG exports when the off-screen card hasn't mounted yet.

### 5. Tailwind classes purged in production that work in dev
This happens when class names are constructed dynamically. In `SavedPanel.jsx:125`, `style={{ backgroundColor: 'var(--accent-color)' }}` uses inline styles for dynamic colors — this is correct and Tailwind-safe. If you ever add a dynamic class like `` `bg-${color}` ``, add it to the `safelist` in `tailwind.config.js`. JIT does not scan interpolated strings.

### 6. `postinstall` fails silently on Railway if `client/` is missing
Railway's Nixpacks runs `npm install` on the root, which triggers `postinstall`, which does `cd client && npm install --include=dev && npm run build`. If `client/package.json` is missing or the client build errors, Railway may continue with a broken or stale `dist/`. Always check the deploy logs for the `vite build` step. The `--include=dev` flag is critical: without it, `npm ci`-style environments skip devDependencies and Vite itself won't be installed.

### 7. VITE_ vars are baked in at build time
If you ever add a `VITE_` variable, its value is frozen at the moment `vite build` runs on Railway. Changing it in the Railway environment panel requires a new deploy (new build). This is unlike server-side env vars which are read at runtime. There are no `VITE_` vars in the codebase today.

### 8. html-to-image and external image CORS
If you add an `<img>` to `QuoteCard` (e.g., a user avatar fetched from Recall or an uploaded logo), html-to-image will attempt to fetch and base64-encode it. The image server must return `Access-Control-Allow-Origin: *` (or your origin). Images without CORS headers will cause the entire `toPng` call to throw a tainted-canvas error. Test with actual production image URLs before shipping.

### 9. Large quote content overflows the card
`QuoteCard.jsx:27-34` has an adaptive font-size ladder (88px → 30px based on character count). Content beyond 400 characters gets `fontSize: 30`, which still risks overflow for very tall text at narrow effective widths. `overflow: 'hidden'` on the card container (`QuoteCard.jsx:53`) silently clips it. There is no truncation or "..." handling. A 600-character message will be clipped.

### 10. Vite dev server proxy and `changeOrigin`
`/socket.io` proxy does NOT set `changeOrigin: true`. The `ws: true` option is what matters for WebSocket upgrade. Adding `changeOrigin` to the socket.io proxy rule would be harmless but is unnecessary.

---

## Risks / TODOs in our current code

1. **`client/tailwind.config.js:7-9` — empty `theme.extend`.**  
   We use CSS variables (`var(--accent-color)`, `var(--text-color)`, `var(--bg-color)`) inline throughout `SavedPanel.jsx` and presumably other components, but these variables are never registered as Tailwind tokens. This means you cannot use them in Tailwind utility classes (e.g., `text-[var(--accent-color)]` would work via JIT arbitrary values, but `text-accent` would not). If a future developer tries to use Tailwind's color system for these, they'll be confused. Consider documenting the CSS-variable architecture in the config file, or register the variables using the channel-only pattern (`rgb(var(--accent-color-channels))`).

2. **`SavedPanel.jsx:89` — `window.location.href = .../api/saved/export.csv`.**  
   This uses a full page navigation for the CSV download. It works, but bypasses the auth fetch layer — the session cookie is sent automatically by the browser, so it's not a security issue, but if the session is expired the user gets a redirect to the login page with a broken CSV download flow. Consider using `fetch()` and a Blob URL download to handle errors gracefully.

3. **`SavedPanel.jsx:93-101` — `downloadJson` revokes the Blob URL synchronously.**  
   `URL.revokeObjectURL(url)` is called immediately after `a.click()`. In some browsers the download may not have started yet. This mirrors the pre-fix pattern for the PNG export (which correctly delays revocation by 2 seconds). The JSON case should also delay revocation.

4. **`client/vite.config.js` — no `base` option set.**  
   The default `base: '/'` is fine for Railway serving at the root path. If we ever move the app to a subpath (e.g., `/app/`), every asset reference will break. This is low risk now but worth noting.

5. **`client/package.json` pins `@vitejs/plugin-react ^4.3.1`.**  
   This plugin bundles its own React Fast Refresh runtime. If `react` bumps to 19.x (currently `^18.3.1`), verify plugin-react compatibility before upgrading.

6. **No `build.rollupOptions` or chunking configured.**  
   `vite build` uses Rollup defaults (automatic chunk splitting). As the codebase grows (more pages, heavier dependencies like charts or PDF), the initial bundle may bloat. Consider explicit `manualChunks` for vendor code if Lighthouse scores degrade.

7. **`QuoteCard.jsx` — font size at 30px for >400 characters still clips.**  
   See Gotcha #9 above. No max-height guard or text truncation exists. File:line: `QuoteCard.jsx:33` (`return 30`).

8. **html-to-image `cacheBust: true` doubles as a correctness guard.**  
   Without it, if the same image URL is seen twice (e.g., operator exports two cards in the same session with a background image), the browser cache may serve a tainted copy. This is only relevant if images are ever added to QuoteCard. Currently moot but the flag earns its keep.

---

## Key links

- Vite 7 announcement: https://vite.dev/blog/announcing-vite7
- Vite env vars & mode: https://vite.dev/guide/env-and-mode.html
- Vite server proxy config: https://vite.dev/config/server-options.html
- Vite build config: https://vite.dev/guide/build.html
- Vite backend integration: https://vite.dev/guide/backend-integration.html
- Vite breaking changes: https://vite.dev/changes/
- Tailwind v3 installation: https://v3.tailwindcss.com/docs/installation
- Tailwind v3 content config: https://v3.tailwindcss.com/docs/content-configuration
- Tailwind v3 functions & directives: https://v3.tailwindcss.com/docs/functions-and-directives
- Tailwind v3 CSS variable pattern: https://v3.tailwindcss.com/docs/customizing-colors
- html-to-image GitHub: https://github.com/bubkoo/html-to-image
- WebKit blob:// download bug (resolved Safari 17.3+): https://bugs.webkit.org/show_bug.cgi?id=216918
