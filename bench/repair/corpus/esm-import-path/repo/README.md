# reports

Storage reports.

- `summarize(files)`: `'2 files, 1.5 KB'` for files `{ name, bytes }`.
- `formatSize(bytes, { binary })`: `'1.5 KB'`, or `'1.5 KiB'` with `binary: true`.
- `formatBytes(bytes)`: the 2.x name of `formatSize`, still exported for compatibility.
