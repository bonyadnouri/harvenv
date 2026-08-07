#!/bin/sh
#
# Install harv — harness virtual environments for Claude Code.
#
#   curl -fsSL https://raw.githubusercontent.com/bonyadnouri/harvenv/main/install.sh | sh
#
# Downloads the release binary for this platform, checks it against the
# checksums published beside it, and puts it on disk. Nothing else: no runtime
# to install first (the binary carries its own — ADR 0007), no sudo, nothing
# written outside the install directory.
#
#   HARV_INSTALL_DIR   where to put it            (default: ~/.local/bin)
#   HARV_VERSION       which release to install   (default: the latest)
#
# POSIX sh on purpose. A clean machine is allowed not to have bash.

set -eu

REPO="bonyadnouri/harvenv"
INSTALL_DIR="${HARV_INSTALL_DIR:-$HOME/.local/bin}"

die() {
	printf 'install: %s\n' "$1" >&2
	exit 1
}

note() { printf '%s\n' "$1" >&2; }

# --- what are we installing onto -------------------------------------------

detect_platform() {
	os=$(uname -s)
	case "$os" in
	Darwin) os="darwin" ;;
	Linux) os="linux" ;;
	*) die "harv has no build for $os. macOS and Linux are supported; Windows is not yet." ;;
	esac

	arch=$(uname -m)
	case "$arch" in
	arm64 | aarch64) arch="arm64" ;;
	x86_64 | amd64) arch="x64" ;;
	*) die "harv has no build for $arch. arm64 and x64 are supported." ;;
	esac

	# The Linux builds link against glibc. Saying so here beats an exec format
	# error on Alpine that looks like a corrupted download.
	if [ "$os" = "linux" ] && command -v ldd >/dev/null 2>&1; then
		if ldd --version 2>&1 | grep -qi musl; then
			die "this looks like a musl system (Alpine). harv currently ships glibc builds only."
		fi
	fi

	printf '%s-%s' "$os" "$arch"
}

# --- fetching ---------------------------------------------------------------

download() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$1" -o "$2" || die "could not download $1"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$2" "$1" || die "could not download $1"
	else
		die "needs curl or wget."
	fi
}

# The /releases/latest redirect names the newest tag without an API call, so
# installing does not spend anyone's unauthenticated rate limit.
latest_version() {
	if command -v curl >/dev/null 2>&1; then
		resolved=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
	elif command -v wget >/dev/null 2>&1; then
		resolved=$(wget -q -S --max-redirect=10 -O /dev/null "https://github.com/$REPO/releases/latest" 2>&1 |
			awk '/^  Location: /{print $2}' | tail -1)
	else
		die "needs curl or wget."
	fi

	version=${resolved##*/tag/v}
	case "$version" in
	"" | *"/"*) die "could not work out the latest version from '$resolved'. Set HARV_VERSION to install a specific one." ;;
	esac
	printf '%s' "$version"
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{print $1}'
	else
		die "needs sha256sum or shasum to verify the download. Refusing to install unverified."
	fi
}

# --- install ----------------------------------------------------------------

main() {
	platform=$(detect_platform)
	version="${HARV_VERSION:-$(latest_version)}"
	version=${version#v}

	asset="harv-$version-$platform.tar.gz"
	base="https://github.com/$REPO/releases/download/v$version"

	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT INT TERM

	note "downloading harv $version for $platform"
	download "$base/$asset" "$tmp/$asset"
	download "$base/checksums.txt" "$tmp/checksums.txt"

	expected=$(awk -v want="$asset" '$2 == want {print $1}' "$tmp/checksums.txt")
	[ -n "$expected" ] || die "checksums.txt for $version does not list $asset."
	actual=$(sha256_of "$tmp/$asset")
	[ "$expected" = "$actual" ] || die "checksum mismatch for $asset
  expected $expected
  actual   $actual
Not installing it."

	tar -xzf "$tmp/$asset" -C "$tmp" || die "could not unpack $asset."
	[ -f "$tmp/harv" ] || die "$asset does not contain a harv binary."

	mkdir -p "$INSTALL_DIR" || die "could not create $INSTALL_DIR."
	# Staged inside the destination so the final step is a rename: upgrading
	# never leaves a half-written harv where a working one used to be, and a
	# running harv is replaced rather than truncated underneath itself.
	staged="$INSTALL_DIR/.harv.install.$$"
	cp "$tmp/harv" "$staged" || die "could not write to $INSTALL_DIR."
	chmod 755 "$staged"
	mv -f "$staged" "$INSTALL_DIR/harv" || die "could not install into $INSTALL_DIR."

	# Prove it runs here before claiming it is installed. `--version` needs no
	# network, no Manifest and no config, so it is the one command that can
	# always answer on a machine that has just met harv.
	HARV_NO_UPDATE_CHECK=1 "$INSTALL_DIR/harv" --version >/dev/null 2>&1 ||
		die "the binary installed but does not run on this machine. Report it: https://github.com/$REPO/issues"

	note ""
	note "installed $(HARV_NO_UPDATE_CHECK=1 "$INSTALL_DIR/harv" --version | head -1) → $INSTALL_DIR/harv"

	case ":$PATH:" in
	*":$INSTALL_DIR:"*) note "run \`harv --help\` to get started." ;;
	*)
		note ""
		note "$INSTALL_DIR is not on your PATH. Add it:"
		note "  export PATH=\"$INSTALL_DIR:\$PATH\""
		;;
	esac
}

# Nothing above ran anything; the install starts here, after the whole script
# has been parsed. A truncated download cannot execute half of it.
main
