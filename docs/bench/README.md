# Bench rows

Rows are `BenchRow` (`src/viewer/bench/handle.ts`), produced per `scripts/bench.md`.
File name = `<date>-<machine>.json`, contents `{ "rows": [...] }`.
`rssDeltaKB` and `headed` are hand-added keys, not part of `runAll`'s output.
`env.date` is UTC (`toISOString()`), so it can roll over to the next day relative to the file name's local date.
