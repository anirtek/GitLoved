# Changelog

## 1.0.0 — 2026-10-02

First public release.

- Branch widget, Commit tool window, Log with commit graph, Pull / Push dialogs, conflict resolution, side-by-side diff viewer, Git console, Welcome screen.
- Security: the server rejects requests with a foreign `Host` (DNS rebinding) or a cross-site `Origin`, and requires `application/json` on POST (CSRF).
- CLI: proper `--help`, `--version` and `--no-browser` flags.
- Fix: the branch popup no longer lists `origin/HEAD` as a remote branch named `origin` on recent git versions.
- Fix: merge commits list their changed files and diffs against the first parent, as the IDE does (previously "0 changed files").
