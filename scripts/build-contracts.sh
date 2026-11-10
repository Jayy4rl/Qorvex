#!/usr/bin/env bash
# Build the three deployable contracts with cargo-near (embeds NEP-330 metadata).
# Output: contracts/target/near/<name>/<name>.wasm, copied to contracts/wasm/.
set -euo pipefail
cd "$(dirname "$0")/../contracts"
mkdir -p wasm
for c in demo-ledger demo-token guardian; do
  echo "== building $c"
  (cd "$c" && cargo near build non-reproducible-wasm)
  cp "target/near/${c//-/_}/${c//-/_}.wasm" "wasm/$c.wasm" 2>/dev/null || cp "target/near/$c/$c.wasm" "wasm/$c.wasm"
done
ls -la wasm
