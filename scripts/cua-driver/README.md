# FalconDeck's bundled Cua patch

Upstream: `trycua/cua`, tag `cua-driver-rs-v0.33.4`, commit
`ba0033a661101669c60ce05f1fe5753bf8bad748`. The Cua Driver Rust crates are MIT
licensed. The pinned archive checksum is in `build-runtime.mjs`.

`browser-snapshot.patch` fixes cyclic parent traversal and disambiguates AX
node ids from separate frames. It includes regressions for self-cycles,
multi-node cycles, reused AX ids across frames, valid ancestry, pagination and action
references. It also installs a request deadline at both daemon invocation
boundaries. `snapshot-watchdog.rs` supplies the native watchdog implementation.

Prepare a patched sidecar with:

```sh
node scripts/prepare-computer-use-runtime.mjs --binary
node --test scripts/cua-driver/build-runtime.test.mjs
rustc --edition=2021 --test scripts/cua-driver/snapshot-watchdog.rs -o /tmp/cua-watchdog-tests
/tmp/cua-watchdog-tests
```

To run dependency tests, apply the patch to the pinned Rust source workspace,
copy `snapshot-watchdog.rs` to
`crates/cua-driver/src/falcondeck_snapshot_watchdog.rs`, and run from FalconDeck's
root so Cargo uses its installed compiler:

```sh
cargo test --manifest-path <source>/Cargo.toml --locked -j 2 -p cua-driver-core --lib
cargo test --manifest-path <source>/Cargo.toml --locked -j 2 -p cua-driver --bin cua-driver snapshot_watchdog
cargo test --locked -j 2 -p falcondeck-daemon --lib app::computer_use::tests
```

When upgrading Cua, refresh the source checksum and matching release skills,
rebase this patch and rerun these tests. Remove the traversal patch once the
upstream fix ships, retaining request recovery unless upstream provides it.
