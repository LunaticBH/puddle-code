<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Warn about low host storage and inodes, report persistence failures, and block new sessions/worktrees at critical capacity (protocol 25.5, local/SSH diagnostics).

### Fixed

- Keep live terminals connected when log writes or SQLite persistence run out of space; bound unsaved history, retry runtime observations and recover without replaying user actions.
- Keep host/configuration reads available without rewriting configuration.
