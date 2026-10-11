# Artboard Ai — Jersey OS

The Artboard Ai web interface for turning one photo that shows both jersey sides into separate front and back artwork jobs. Production hosting uses a Cloudflare Worker for the access gate and engine proxy, with Cloudflare Static Assets serving the Vite build.

## Run in the Replit workspace

Requirements: Node.js 20.19 or newer and pnpm.

```sh
pnpm install
pnpm dev
```

The Replit development preview bypasses the production access-code screen and reaches the development engine through the workspace API Server. The browser always calls same-origin `/api/engine`; it never receives the engine token.

## Run the Cloudflare Worker locally

Create an ignored `.dev.vars` file in this directory with local values for `ARTBOARD_WEB_ACCESS_CODE`, `ARTBOARD_WEB_SESSION_SECRET`, and `ARTBOARD_ENGINE_TOKEN`. The session secret must contain at least 32 bytes; the license key must contain at least 15 characters. `ARTBOARD_ENGINE_URL` is optional and defaults to the Jersey OS Railway engine.

```sh
pnpm install
pnpm run cf:dev
```

This builds the frontend and runs the configured Worker and static-asset binding locally. Never commit `.dev.vars`.

## Deploy to Cloudflare Workers

`wrangler.jsonc` configures the Worker entry point, Vite asset directory, SPA fallback, security-header path, and Cloudflare login rate-limit binding. The current static-only Worker must receive a deployment that includes this Worker entry point; static assets alone cannot run authentication or the engine proxy.

For a CLI deployment:

```sh
pnpm install --frozen-lockfile
pnpm run cf:deploy
```

For a Git-connected Cloudflare build, use `pnpm run build` as the build command and `pnpm exec wrangler deploy` as the deploy command. After the Worker script is deployed, add these values under that Worker's **Settings → Variables and Secrets**:

| Name | Type | Purpose |
|---|---|---|
| `ARTBOARD_WEB_ACCESS_CODE` | Secret | Private license key shared with the client team; at least 15 characters. |
| `ARTBOARD_WEB_SESSION_SECRET` | Secret | Random value of at least 32 bytes for signing secure, HTTP-only sessions. |
| `ARTBOARD_ENGINE_TOKEN` | Secret | The same bearer token configured on the Railway engine; keep it server-side. |
| `ARTBOARD_ENGINE_URL` | Variable (optional) | Engine origin; defaults to `https://artboardaitool-jerseyos-engine-production.up.railway.app`. |

`GET /api/healthz` reports whether the required secrets and bindings are configured. The Worker rate-limits access-code submissions to 10 attempts per minute per client IP at each Cloudflare location. Keep secrets out of `VITE_*` variables and source control.

The shared code is suitable for a controlled client pilot, not per-user identity, job ownership, or upload retention.

## Workflow and current limits

1. Upload one PNG, JPEG, WebP, or TIFF photo showing both panels.
2. Review actual image-analysis observations returned by the engine.
3. Assign front and back to engine-detected regions, or draw/enter manual crop bounds.
4. Select 330 or 600 DPI for any raster content that remains and choose engine-supported SVG/EPS outputs.
5. Review the real job status, trace report, preflight, and limitations.
6. Inspect only previews and vector files returned by the engine; object-level editing is not implemented in this web app.
7. Download available files or the actual engine bundle.

The canvas dimensions and color handling are read from the engine capabilities at runtime. Local geometry detection does not identify which panel is the front or back. AI analysis is available only when the backend reports it configured and the operator explicitly opts in. Native Illustrator `.ai` output, automatic fabric flattening, hidden-artwork reconstruction, and printer approval are not provided by this interface.

## Tests

```sh
pnpm test
pnpm typecheck
node --check worker.mjs
```
