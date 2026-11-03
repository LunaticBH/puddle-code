<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.3.14] — 2026-11-03

### Fixed

- Suppress duplicate terminal colour replies from xterm when the daemon answers startup theme queries, preserving legacy viewer replies and replay suppression.
- Keep notebook code visible during editor mounting and stabilise cell sizing, vertical scrolling, focused editing and reading-position restoration.
- Keep the profile name and neighbouring icons stationary when entering inline rename, then resize the field with each edit.
