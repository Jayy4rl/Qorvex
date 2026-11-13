#!/usr/bin/env bash
# Build the deployable contracts with cargo-near (embeds NEP-330 metadata).
# Output: contracts/target/near/<name>/<name>.wasm, copied to contracts/wasm/.
#
#   bash contracts/build.sh              # all three
#   bash contracts/build.sh guardian     # only the named ones
#
# Rebuilding demo-ledger can change its code hash, which is part of the AI
# fixture keys (backend/fixtures/ai); rebuild it only when re-recording them.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p wasm
targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(demo-ledger demo-token guardian)
for c in "${targets[@]}"; do
  echo "== building $c"
  (cd "$c" && cargo near build non-reproducible-wasm)
  cp "target/near/${c//-/_}/${c//-/_}.wasm" "wasm/$c.wasm" 2>/dev/null || cp "target/near/$c/$c.wasm" "wasm/$c.wasm"
done
ls -la wasm
