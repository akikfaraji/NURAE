#!/usr/bin/env bash
# Task 9 verification: exercise setup.sh's ensure_node() node-less end-to-end.
# Simulates the user's Termux Debian box: no real node (poisoned stub) AND
# unusable package managers (apt-get/dnf/apk/brew stubs exit 1), isolated HOME.
# Expected path: NodeSource attempt fails -> plain apt fails -> official
# tarball fallback downloads node v22.14.0 -> "Node.js v22.14.0 ready".
set -euo pipefail
cd /home/z/my-project

STUB=/home/z/my-project/scripts/nostub-stubs
ISO=/home/z/my-project/.tmp-node-home
rm -rf "$STUB" "$ISO"
mkdir -p "$STUB" "$ISO"

# poisoned node + failing package managers
printf '#!/bin/sh\nexit 127\n' > "$STUB/node"
for pm in apt-get dnf apk brew; do printf '#!/bin/sh\nexit 1\n' > "$STUB/$pm"; done
chmod +x "$STUB/"*

# Build the harness: helpers + every node function extracted from setup.sh
{
  echo 'MODE=test'
  echo 'say()  { printf "\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n" "$*"; }'
  echo 'warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }'
  echo 'die()  { printf "\033[1;31m[error]\033[0m %s\n" "$*" >&2; exit 1; }'
  sed -n '/^node_major()/,/^# --- 2\./p' setup.sh
  echo 'ensure_node'
} > "$ISO/harness.sh"

echo "### run 1: node-less + broken package managers -> must fall back to tarball"
export PATH="$STUB:$PATH"
export HOME="$ISO"
bash "$ISO/harness.sh"

echo "### version via the tarball-installed node:"
"$ISO/.local/nurae-node/bin/node" --version

echo "### .bashrc persistence lines:"
tail -3 "$ISO/.bashrc"

echo "### run 2 (normal env, real node present): must short-circuit"
unset PATH; export PATH="/usr/local/bin:/usr/bin:/bin"
bash "$ISO/harness.sh"

echo "ALL-ENSURE-NODE-TESTS-PASSED"
