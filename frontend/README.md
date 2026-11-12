# @qorvex/frontend

The Qorvex web app: the public site (landing page and documentation) and operator sign-in. React 19, react-router 7 and Vite, with no component library. The backend serves the production build from `frontend/dist`, so `/api` is same-origin.

## Routes

| Path | What |
| --- | --- |
| `/` | Landing page ([src/pages/landing](src/pages/landing)) |
| `/docs`, `/docs/:slug` | Documentation. The table of contents is [src/lib/docs-index.ts](src/lib/docs-index.ts); page content is in [src/pages/docs/content](src/pages/docs/content). |
| `/sign-in` | Operator sign-in. Checks `QORVEX_ADMIN_TOKEN` against `GET /api/protocols` and keeps it in `sessionStorage` for the tab. |
| `/app` | Signed-in entry point. Shows the server's `/api/health`; the operator console UI is not rebuilt yet. |
| anything else | 404 (for `/status/<id>`, it points at the JSON endpoint `/api/status/<id>`) |

## Commands

From the repository root:

- `npm run dev:web`: Vite dev server on http://localhost:5173, proxying `/api` to `QORVEX_API` (default http://localhost:8787). Run `npm run demo` or `npm start` alongside it.
- `npm run build:web`: type-check and build into `frontend/dist`. `npm start` and `npm run demo` rebuild automatically when sources are newer than the build (`scripts/ensure-built.mjs`; skip with `QORVEX_SKIP_WEB_BUILD=1`).
- `npm run test:web`: server-renders every page and checks that every internal link and `#anchor` resolves, that the docs registry matches its content, and the sign-in token check.

## Design

Tokens live on `:root` in [src/styles/global.css](src/styles/global.css): near-black olive surfaces (`--bg: #090a08`), one lime accent (`--lime: #c5f52d`), off-white text (`--text: #f3f1e9`). Type is Instrument Serif for display (italic, in lime, for emphasis), Inter for body and JetBrains Mono for labels and system data, all self-hosted through Fontsource. Page styles: `chrome.css` (header and footer), `landing.css`, `docs.css`, `auth.css`. Motion respects `prefers-reduced-motion`.

The landing page's product preview uses only values from the recorded sandbox demo run ([src/pages/landing/demo-run.ts](src/pages/landing/demo-run.ts)) and says so on the page.
