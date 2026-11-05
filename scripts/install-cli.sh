#!/bin/sh
# Standalone CLI installer, published as install.sh. Daemon bootstrap stays embedded.
# Release/app builds bake @@REPO@@; source runs accept --repo or PUDDLE_REPO.
# Keep old releases: running cockpits still serve assets from their own tree.
set -eu

say() { printf 'puddle install: %s\n' "$1"; }
die() { printf 'puddle install: error: %s\n' "$1" >&2; exit 1; }
usage() {
  cat <<'EOF'
usage: install.sh [--version X.Y.Z] [--repo owner/repo]
                      [--prefix <directory>] [--bin-dir <directory>]
                      [--tarball <path>] [--sums <path>]

Installs the CLI with its own Node runtime; no npm or sudo required.
  --version   release to install (default: latest); also accepts vX.Y.Z
  --prefix    installation root (default: ~/.local/share/puddle/cli,
              respecting XDG_DATA_HOME or PUDDLE_CLI_HOME)
  --bin-dir   launcher directory (default: ~/.local/bin)
  --tarball   local archive for offline/development installation
  --sums      SHA256SUMS for a local archive (otherwise warns and skips)
  --repo      GitHub release repository (or PUDDLE_REPO)
EOF
}

main() {
  REPO="${PUDDLE_REPO:-@@REPO@@}"
  VERSION=""
  PREFIX="${PUDDLE_CLI_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/puddle/cli}"
  BIN_DIR="$HOME/.local/bin"
  TARBALL=""
  SUMS=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --version|--repo|--prefix|--bin-dir|--tarball|--sums)
        [ $# -ge 2 ] && [ -n "$2" ] || die "$1 requires a value"
        case "$1" in
          --version) VERSION=${2#v} ;; --repo) REPO=$2 ;;
          --prefix) PREFIX=$2 ;; --bin-dir) BIN_DIR=$2 ;;
          --tarball) TARBALL=$2 ;; --sums) SUMS=$2 ;;
        esac
        shift 2 ;;
      -h|--help) usage; return ;;
      *) die "unknown flag $1 (see --help)" ;;
    esac
  done
  OS=$(uname -s)
  case "$OS" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) die "unsupported OS $OS" ;; esac
  ARCH=$(uname -m)
  case "$ARCH" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported architecture $ARCH" ;; esac
  if [ "$OS" = linux ] && [ -f /etc/alpine-release ]; then
    die "the bundled Node runtime requires glibc; Alpine is not supported"
  fi
  case "$PREFIX" in /*) ;; *) die "--prefix must be an absolute path" ;; esac
  case "$BIN_DIR" in /*) ;; *) die "--bin-dir must be an absolute path" ;; esac
  while [ "$PREFIX" != / ] && [ "${PREFIX%/}" != "$PREFIX" ]; do PREFIX=${PREFIX%/}; done
  [ ! -L "$PREFIX" ] || die "installation root must not be a symlink"
  umask 077
  mkdir -p "$PREFIX"
  PREFIX=$(CDPATH= cd -- "$PREFIX" && pwd -P)
  case "$OS" in
    darwin) OWNER=$(stat -f '%u' "$PREFIX"); MODE=$(stat -f '%Lp' "$PREFIX") ;;
    linux) OWNER=$(stat -c '%u' "$PREFIX"); MODE=$(stat -c '%a' "$PREFIX") ;;
  esac
  [ "$OWNER" = "$(id -u)" ] && [ "$((0$MODE & 0022))" -eq 0 ] || die "installation root must be owned by you and not writable by others"
  if [ -e "$PREFIX/INSTALLATION" ]; then
    [ ! -L "$PREFIX/INSTALLATION" ] && [ "$(cat "$PREFIX/INSTALLATION")" = puddle-cli ] || die "unrecognised installation root"
  else
    [ -z "$(ls -A "$PREFIX")" ] || die "refusing a non-empty unmanaged installation root"
    printf 'puddle-cli\n' > "$PREFIX/INSTALLATION"
  fi
  chmod 700 "$PREFIX"
  mkdir "$PREFIX/.install-lock" 2>/dev/null || die "another installer is running (if interrupted, remove $PREFIX/.install-lock and retry)"
  WORK=""
  STAGE=""
  trap 'test -z "$WORK" || rm -rf "$WORK"; if [ -n "$STAGE" ] && [ "$(readlink "$PREFIX/current" 2>/dev/null || true)" != "versions/$(basename "$STAGE")" ]; then rm -rf "$STAGE"; fi; rmdir "$PREFIX/.install-lock"' 0
  trap 'exit 1' 1 2 3 15
  [ ! -L "$PREFIX/versions" ] || die "versions must not be a symlink"
  mkdir -p "$PREFIX/versions" "$BIN_DIR"
  BIN_DIR=$(CDPATH= cd -- "$BIN_DIR" && pwd -P)
  WORK=$(mktemp -d "$PREFIX/.download.XXXXXX")

  if [ -n "$TARBALL" ]; then
    [ -f "$TARBALL" ] || die "tarball not found: $TARBALL"
    TARBALL="$(CDPATH= cd -- "$(dirname -- "$TARBALL")" && pwd)/$(basename -- "$TARBALL")"
    if [ -z "$VERSION" ]; then
      VERSION=$(basename "$TARBALL" | sed -n "s/^puddle-cli-v\(.*\)-$OS-$ARCH.tar.gz\$/\1/p")
    fi
  else
    case "$REPO" in *@@*|'') die "no repository baked in; pass --repo owner/repo" ;; esac
    command -v curl >/dev/null 2>&1 || die "curl is required"
    if [ -z "$VERSION" ]; then
      LATEST=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") || die "cannot resolve latest release"
      VERSION=$(printf '%s' "$LATEST" | sed -n 's#.*/tag/v\{0,1\}##p')
    fi
  fi
  # Version strings become paths; accept release semver, including prereleases.
  printf '%s\n' "$VERSION" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$' || die "invalid release version: $VERSION"
  FILE="puddle-cli-v$VERSION-$OS-$ARCH.tar.gz"
  if [ -z "$TARBALL" ]; then
    BASE="https://github.com/$REPO/releases/download/v$VERSION"
    TARBALL="$WORK/$FILE"
    SUMS="$WORK/SHA256SUMS"
    say "fetching $BASE/$FILE"
    curl -fSL --progress-bar -o "$TARBALL" "$BASE/$FILE" || die "download failed (this platform/version may not be published)"
    curl -fsSL -o "$SUMS" "$BASE/SHA256SUMS" || die "checksums download failed"
  fi
  if [ -n "$SUMS" ]; then
    [ -f "$SUMS" ] || die "checksums file not found: $SUMS"
    EXPECTED=$(awk -v name="$(basename "$TARBALL")" '$2 == name {print $1}' "$SUMS")
    [ "${#EXPECTED}" -eq 64 ] || die "missing or ambiguous checksum"
    if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TARBALL" | cut -d ' ' -f 1)
    elif command -v shasum >/dev/null 2>&1; then ACTUAL=$(shasum -a 256 "$TARBALL" | cut -d ' ' -f 1)
    else die "sha256sum or shasum is required"
    fi
    [ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch"
  else
    say "warning: --tarball without --sums — checksum verification skipped"
  fi
  STAGE=$(mktemp -d "$PREFIX/versions/$VERSION.XXXXXX")
  tar -xzf "$TARBALL" --strip-components=1 -C "$STAGE" || die "extraction failed"
  [ "$(cat "$STAGE/STANDALONE")" = puddle-cli ] && [ "$(cat "$STAGE/VERSION")" = "$VERSION" ] || die "archive metadata mismatch"
  for ASSET in cli/index.js cli/host-control.mjs cli/public/index.html cli/install.sh cli/install-cli.sh; do
    [ -f "$STAGE/$ASSET" ] || die "archive is missing $ASSET"
  done
  # Help loads the bundle without touching a daemon or user state.
  "$STAGE/puddle" --help >/dev/null || die "CLI smoke test failed"
  if [ -f "$STAGE/pudl" ]; then
    "$STAGE/pudl" --help >/dev/null || die "pudl smoke test failed"
  elif [ -f "$STAGE/puddlang" ]; then
    "$STAGE/puddlang" --help >/dev/null || die "puddlang smoke test failed"
  fi
  "$STAGE/bin/node" --input-type=commonjs - "$PREFIX" "$BIN_DIR" "$STAGE" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [root, binDir, stage] = process.argv.slice(2);
const launcher = path.join(binDir, 'puddle');
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const wrapper = '#!/bin/sh\n# puddle standalone launcher\nexec ' + quote(path.join(root, 'current/puddle')) + ' "$@"\n';
// Older archives remain installable; current releases provide only pudl.
const scriptCommand = ['pudl', 'puddlang'].find((name) => fs.existsSync(path.join(stage, name)));
const scriptLauncher = path.join(binDir, scriptCommand || 'pudl');
const scriptWrapperFor = (name) => '#!/bin/sh\n# puddle standalone launcher\nexec ' + quote(path.join(root, 'current', name)) + ' "$@"\n';
const scriptWrapper = scriptWrapperFor(scriptCommand || 'pudl');
const hasScript = scriptCommand !== undefined;
const stat = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
if (stat(launcher) && (!stat(launcher).isFile() || fs.readFileSync(launcher, 'utf8') !== wrapper)) {
  throw Error('Refusing to replace an unrelated launcher: ' + launcher + '; choose --bin-dir');
}
const ownsScript = stat(scriptLauncher)?.isFile() && fs.readFileSync(scriptLauncher, 'utf8') === scriptWrapper;
if (hasScript && stat(scriptLauncher) && !ownsScript) throw Error('Refusing to replace an unrelated launcher: ' + scriptLauncher + '; choose --bin-dir');
const current = path.join(root, 'current');
if (stat(current) && !stat(current).isSymbolicLink()) throw Error('current must be a symlink');
const record = path.join(root, 'installation.json');
if (stat(record)) {
  const old = JSON.parse(fs.readFileSync(record, 'utf8'));
  if (old.launcher !== launcher) throw Error('Reuse the original --bin-dir: ' + path.dirname(old.launcher));
}
const tmp = '.new-' + process.pid;
try {
  fs.writeFileSync(record + tmp, JSON.stringify({ kind: 'puddle-cli', launcher, ...(hasScript ? { scriptLauncher } : {}) }) + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(launcher + tmp, wrapper, { flag: 'wx', mode: 0o755 });
  if (hasScript) fs.writeFileSync(scriptLauncher + tmp, scriptWrapper, { flag: 'wx', mode: 0o755 });
  fs.symlinkSync(path.relative(root, stage), current + tmp);
  fs.renameSync(record + tmp, record);
  fs.renameSync(launcher + tmp, launcher);
  if (hasScript) fs.renameSync(scriptLauncher + tmp, scriptLauncher);
  fs.renameSync(current + tmp, current); // Activate only after every other write succeeds.
  // Remove only exact wrappers owned by this installation when the command
  // changes or a named older release does not contain a scripting command.
  for (const name of ['pudl', 'puddlang']) {
    if (name === scriptCommand) continue;
    const obsolete = path.join(binDir, name);
    if (stat(obsolete)?.isFile() && fs.readFileSync(obsolete, 'utf8') === scriptWrapperFor(name)) fs.unlinkSync(obsolete);
  }
} finally {
  for (const file of [record + tmp, launcher + tmp, scriptLauncher + tmp, current + tmp]) fs.rmSync(file, { force: true });
}
NODE
  STAGE="" # Published releases stay intact, including those serving live cockpits.
  say "installed CLI $VERSION at $BIN_DIR/puddle"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "add $BIN_DIR to PATH (for example in your shell profile)" ;; esac
  RESOLVED=$(command -v puddle || true)
  if [ -n "$RESOLVED" ] && [ "$RESOLVED" != "$BIN_DIR/puddle" ]; then
    say "warning: $RESOLVED precedes this installation on PATH; use $BIN_DIR/puddle or update PATH"
  fi
}

# Read the complete script before doing work when invoked through curl | sh.
main "$@"
