<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Suppress duplicate terminal colour replies from xterm when the daemon answers startup theme queries, preserving legacy viewer replies and replay suppression.
- Keep notebook code visible during editor mounting and stabilise cell sizing, vertical scrolling, focused editing and reading-position restoration.
- Keep the profile name and neighbouring icons stationary when entering inline rename, then resize the field with each edit.
