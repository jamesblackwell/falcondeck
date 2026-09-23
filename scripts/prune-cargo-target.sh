#!/bin/sh
# Remove Cargo build units under target/ that no build has used in DAYS days
# (default 14). Cargo reads a unit's .fingerprint files on every build that
# includes it, so their access time marks the unit as live. Artifacts from old
# dependency versions, feature sets, and toolchains are never read again and
# otherwise pile up in deps/ indefinitely. Removing a live unit by mistake only
# costs a rebuild. DAYS=0 disables the sweep.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
target="${CARGO_TARGET_DIR:-$root/target}"
days="${1:-14}"

case "$days" in '' | *[!0-9]*) echo "usage: $0 [days]" >&2; exit 2 ;; esac
[ "$days" -gt 0 ] || exit 0
[ -d "$target" ] || exit 0

live=$(mktemp)
doomed=$(mktemp)
trap 'rm -f "$live" "$doomed"' EXIT

# Unit names end in a 16-hex-digit metadata hash, e.g. libserde-0123456789abcdef.rlib.
hash_awk='BEGIN { h = "[0-9a-f]"; re = "-" h h h h h h h h h h h h h h h h "([.]|$)" }'

find "$target" -maxdepth 3 -type d -name .fingerprint | while IFS= read -r fingerprint; do
	profile=$(dirname "$fingerprint")

	find "$fingerprint" -mindepth 2 -maxdepth 2 -type f -atime "-$days" |
		awk -F/ "$hash_awk"' { n = $(NF - 1); if (match(n, re)) print substr(n, RSTART + 1, 16) }' |
		sort -u >"$live"

	for dir in "$profile/deps" "$profile/build" "$fingerprint"; do
		[ -d "$dir" ] || continue
		find "$dir" -mindepth 1 -maxdepth 1 -mtime "+$days" |
			awk -v live="$live" "$hash_awk"'
				BEGIN { while ((getline k < live) > 0) keep[k] = 1 }
				{ n = $0; sub(/.*\//, "", n); if (match(n, re) && !(substr(n, RSTART + 1, 16) in keep)) print }
			' >>"$doomed"
	done

	if [ -d "$profile/incremental" ]; then
		find "$profile/incremental" -mindepth 1 -maxdepth 1 -type d | while IFS= read -r session; do
			if [ -z "$(find "$session" -type f -atime "-$days" -print | head -n 1)" ]; then
				echo "$session" >>"$doomed"
			fi
		done
	fi
done

[ -s "$doomed" ] || exit 0

freed_kb=$(tr '\n' '\0' <"$doomed" | xargs -0 du -sk | awk '{ s += $1 } END { print s + 0 }')
tr '\n' '\0' <"$doomed" | xargs -0 rm -rf
echo "Pruned $((freed_kb / 1024)) MB of Cargo artifacts unused for $days+ days"
