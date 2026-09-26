# Embedding the Point Cloud Editor

## Two ways in

1. **Proxy + iframe** (what the Lab does). The host proxies `/point-cloud/app/*` to the standalone deployment and shows it in an `<iframe>`. Zero coupling: no shared deps, no build changes, the viewer ships on its own schedule.
2. **Component copy.** Copy `src/viewer/` into a React host and render `<PointCloudViewer>` directly. Tighter integration (host tokens, `onApi`), but the host takes on three/fiber/drei pins and a WebGPU-capable build.

## Proxy / iframe

### Deploy order

The proxy makes the `*.vercel.app` host same-origin with `lab.merttoka.com`; `*.vercel.app` names are claimed globally, so pushing the Lab route before the project is owned would hand a stranger who later claims that name same-origin access to Lab storage. Order:

1. Create and own the Vercel project `point-cloud-editor`.
2. Confirm its exact production URL equals the Lab route's `dest`.
3. `tools/.venv/bin/python tools/check_hosting.py --no-cors https://point-cloud-editor.vercel.app/point-cloud/app/data/full/points.bin` passes `range 206`.
4. Only then push the Lab.

The standalone app is built with `base: '/point-cloud/app/'` and deployed at `https://point-cloud-editor.vercel.app` (data under `/point-cloud/app/data/{demo,full}/`). The Lab's `vercel.json` routes it through its own origin; the routes must come **before** `{ "handle": "filesystem" }` so the SPA fallback never swallows them. Excerpt (the Lab's other routes omitted):

```json
{
  "routes": [
    { "src": "/point-cloud/app", "headers": { "Location": "/point-cloud/app/" }, "status": 308 },
    { "src": "/point-cloud/app/(.*)", "dest": "https://point-cloud-editor.vercel.app/point-cloud/app/$1" },
    { "handle": "filesystem" },
    { "src": "/(.*)", "dest": "/" }
  ]
}
```

Iframe (React; the Lab's `src/experiments/point-cloud/index.tsx`):

```tsx
const [src] = useState(() => `/point-cloud/app/?theme=${resolved}`)   // fixed at mount: a new src reloads the viewer and its data
useEffect(() => {
  frame.current?.contentWindow?.postMessage({ type: 'pcv-theme', theme: resolved }, window.location.origin)
}, [resolved])
return <iframe ref={frame} src={src} title="Point Cloud Editor" allow="fullscreen" />
```

Theme contract:
- `?theme=dark|light` sets the palette on first load (anything else → `dark`).
- `postMessage({ type: 'pcv-theme', theme: 'dark' | 'light' }, location.origin)` switches it in place, no reload, no refetch.
- Messages from any origin other than the viewer's own are ignored. Through the proxy the iframe and the host share an origin, so the host posts to `location.origin`. A cross-origin iframe (no proxy) cannot switch theme; use `?theme=` only.

Other URL params the standalone page reads: `?data=<name>` (`demo` default, `full` = 20M), `?dpr=`, `?bench=1` (see [Bench handle](#bench-handle)).

Focus: keyboard shortcuts are bound on the viewer root element, never on `window`/`document`, so they never fire on the host page. The user clicks the canvas once to focus the iframe before keys work.

Locally the Lab has no proxy: `npm run dev` → `/point-cloud` shows the header and an empty frame (the request falls through to the Lab's own SPA). Test the real thing on the deployed Lab.

## Component copy

Copy `src/viewer/` into the host (drop `*.test.ts`), then:

```tsx
import { PointCloudViewer } from './viewer/PointCloudViewer'

<div style={{ position: 'absolute', inset: 0 }}>
  <PointCloudViewer manifestUrl="/data/demo/manifest.json" theme="dark" />
</div>
```

The viewer fills its parent; give the parent a size.

### Dependencies (exact pins)

| package | version | notes |
|---|---|---|
| `three` | `0.186.0` | `three/webgpu` + `three/tsl` |
| `@react-three/fiber` | `9.7.0` | peer `react >=19 <19.3` |
| `@react-three/drei` | `10.7.8` | |
| `fflate` | `0.8.3` | export zip |
| `@types/three` | `0.186.0` | dev |
| `@webgpu/types` | `^0.1.69`–`^0.1.72` | dev (tested range: Lab / this repo); add to `compilerOptions.types` |
| `react` / `react-dom` | `19.x < 19.3` | fiber's peer range |

`.npmrc` with `legacy-peer-deps=true` is needed only if the host pins `react ≥ 19.3` (outside fiber 9.7's peer range). This repo does exactly that (react 19.3.0 + `legacy-peer-deps=true`) and runs fine.

### Props

| prop | type | meaning |
|---|---|---|
| `manifestUrl` | `string` | URL of `manifest.json`; `points.bin` is resolved next to it |
| `theme?` | `'dark' \| 'light'` | palette; omitted = dark. Changing it re-themes in place |
| `className?` | `string` | added to the root element |
| `dpr?` | `number` | canvas pixel ratio override (default: device) |
| `onApi?` | `(handle: BenchHandle) => void` | called once per loaded dataset with the bench/automation handle |

### Tokens

The root defines `--pcv-*` from the host's Lab-named tokens, falling back to its own palette (`theme/tokens.module.css`). Set the Lab names on an ancestor to restyle it:

| `--pcv-*` | reads | dark fallback | light fallback |
|---|---|---|---|
| `--pcv-bg` | `--bg` | `#0a0a0a` | `#fcfcfc` |
| `--pcv-surface` | `--bg-surface` | `#141414` | `#f5f5f5` |
| `--pcv-card` | `--bg-card` | `#1a1a1a` | `#fff` |
| `--pcv-text` | `--text-primary` | `#e0e0e0` | `#111` |
| `--pcv-text-2` | `--text-secondary` | `#999` | `#444` |
| `--pcv-muted` | `--text-muted` | `#666` | `#666` |
| `--pcv-border` | `--border` | `#222` | `#e0e0e0` |
| `--pcv-accent` | `--accent` | `#BF1656` | `#BF1656` |
| `--pcv-font` | `--font-body` | `'Manrope', sans-serif` | same |
| `--pcv-mono` | `--font-mono` | `'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace` | same |
| `--pcv-radius` | `--radius` | `10px` | same |

The selection tint follows `--pcv-accent`, read from the viewer's own root.

### No WebGPU

Without `navigator.gpu` the root renders the message "WebGPU not available in this browser." and nothing else; nothing throws, so no error boundary is needed. Load errors show the same way.

### Worker

The loader starts `new Worker(new URL('./loader.worker.ts', import.meta.url), { type: 'module' })`. Vite resolves and bundles that pattern (it emits `assets/loader.worker-*.js`) with no config. Other bundlers need their worker plugin (webpack 5 handles `new URL(…, import.meta.url)` natively; others vary). The viewer imports no `.wgsl` files and uses no `?raw` imports: every kernel is an inline template string passed to three's `wgslFn`/`wgsl`, so no `assetsInclude` or module declaration is needed.

### Toolchain notes

From a spike with the Lab's exact toolchain (its `package.json` + `package-lock.json`, `tsconfig*.json`, `vite.config.ts`, `index.html`; Vite 7.3.1, React 19.2.4, TypeScript 5.9.3, `@vitejs/plugin-react` 5.1.4). `tsc -b && vite build` passed and `vite preview` rendered the 2M demo (2,000,000 / 2,000,000, ~120 fps, clean console apart from three's own deprecation warnings).

- **Install react with the viewer deps**: `npm install react@19.2.4 react-dom@19.2.4 three@0.186.0 @react-three/fiber@9.7.0 @react-three/drei@10.7.8 fflate@0.8.3 @types/three@0.186.0`. Installing only the viewer deps against `"react": "^19.2.0"` re-resolves react to 19.3.0 and fails with `ERESOLVE … peer react@">=19 <19.3" from @react-three/fiber@9.7.0`. Pinning react inside fiber's range (or `legacy-peer-deps=true`) fixes it.
- **`"strictNullChecks": true`** in the host's `tsconfig.app.json`. With the Lab's `strict: false`, `tsc` fails on `src/viewer/edit/EditRunner.tsx(16,20): TS2352 Conversion of type 'EventDispatcher<{}>' to type '{ enabled: boolean; }' may be a mistake` (without null checks both sides of the `as … | null` cast lose their `null` and no longer overlap). That one flag is enough; the Lab's own code also passes with it on.
- `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUncheckedSideEffectImports`, `allowImportingTsExtensions`, `moduleResolution: bundler`: no changes needed.
- `types: ["vite/client", "@webgpu/types"]`: needed as-is (`vite/client` types the `*.module.css` imports, `@webgpu/types` the GPU calls).
- Vite config: none. The Lab's `assetsInclude: ['**/*.wgsl']` is harmless and unused by the viewer; the default `worker.format` works.
- Bundle: one ~1.9 MB (526 kB gzip) chunk plus a 17 kB worker; Vite prints its >500 kB chunk warning. `lazy()`-load the page that hosts the viewer if that matters.

## Data

- `manifest.json` and `points.bin` sit in the same directory; `manifestUrl` points at the manifest and the bin is resolved relative to it.
- Chunks are fetched with HTTP `Range` requests (each chunk's `offset`/`count` from the manifest). If the first response is `200` without `Content-Range`, the loader falls back to one full fetch of `points.bin` and slices chunks locally.
- Cross-origin data needs `Access-Control-Allow-Origin` on every redirect hop (GitHub release assets have none; serve same-origin or through a proxy).
- Probe a host before pointing the viewer at it: `tools/check_hosting.py [--no-cors] URL` (Range 206, `Content-Range`, CORS per hop; `--no-cors` for same-origin/proxied hosts). Example: `tools/check_hosting.py --no-cors https://lab.merttoka.com/point-cloud/app/data/full/points.bin`.
- Sizes: demo 2M points, `points.bin` 16 MB; full 20M points, 160 MB.
- Attribution the host page must show:

  > City of Vancouver LiDAR 2022 · Contains information licensed under the Open Government Licence – Vancouver.

## Bench handle

`onApi` receives a `BenchHandle` (`src/viewer/bench/handle.ts`) once the dataset loads: state reads, `setBudget`, `edl`, `orbit`, `lasso`, `record`, `cpuBench`, `verify`, `runAll`, … The standalone harness exposes it only under `?bench=1`:

```tsx
declare global { interface Window { __pcv?: BenchHandle } }
const attach = (h: BenchHandle) => { window.__pcv = h }
<PointCloudViewer manifestUrl={url} onApi={params.bench ? attach : undefined} />
```

Then drive it from Playwright, e.g. `browser_evaluate` `async () => JSON.stringify(await __pcv.runAll({ skipCpu: true }))`. The full procedure (environment, per-dataset steps, row → README mapping, media capture) is `scripts/bench.md`.
