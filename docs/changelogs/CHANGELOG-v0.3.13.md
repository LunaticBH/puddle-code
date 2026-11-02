<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.3.13] — 2026-11-02

### Added

- Default inactive bulk terminal logs to three-day retention, preserving archived restoration, replay tails, snapshots and shell history; expose the host setting in protocol 25.6.
- Warn about low host storage and inodes, report persistence failures, and block new sessions/worktrees at critical capacity (protocol 25.5, local/SSH diagnostics).

### Fixed

- Keep live terminals connected when log writes or SQLite persistence run out of space; bound unsaved history, retry runtime observations and recover without replaying user actions.
- Keep host/configuration reads available without rewriting configuration.
