# Point Cloud Editor

Clean-room WebGPU point cloud viewer/editor. 5–20M point LiDAR, WGSL compute, editing, explicit perf numbers.

## Status
Phase 0: scaffold + spike.

## Setup
npm install
npm run dev        # Chrome with WebGPU
npm test
npm run build

`.npmrc` sets `legacy-peer-deps=true`: @react-three/fiber@9.7.0 peer range (`react >=19 <19.3`) excludes pinned react@19.3.0.

## Spike params
`?n=2000000&size=3` — point count, point size px.
