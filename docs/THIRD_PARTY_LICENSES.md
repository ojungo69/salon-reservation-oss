# Third-Party Licenses

## Runtime

The application bundle has no runtime npm dependency. It uses browser standards and Cloudflare
platform APIs supplied by the deployer's environment.

## Direct development dependencies

| Package | Version | License |
|---|---:|---|
| `@axe-core/playwright` | 4.12.1 | MPL-2.0 |
| `@cloudflare/vitest-pool-workers` | 0.20.3 | MIT |
| `@playwright/test` | 1.62.1 | Apache-2.0 |
| `@types/node` | 24.13.3 | MIT |
| `typescript` | 7.0.2 | Apache-2.0 |
| `vitest` | 4.1.11 | MIT |
| `wrangler` | 4.120.0 | MIT OR Apache-2.0 |

`package-lock.json` is authoritative for transitive versions. The release audit permits only the
license expressions present in the locked development tree:

```text
0BSD
Apache-2.0
Apache-2.0 AND LGPL-3.0-or-later
Apache-2.0 AND LGPL-3.0-or-later AND MIT
BSD-3-Clause
CC0-1.0
ISC
LGPL-3.0-or-later
MIT
MIT OR Apache-2.0
MPL-2.0
```

These packages are tools and are not shipped as application code. Their notices and full license
texts remain in the installed packages. Run `npm ci && npm run release:audit` after every lockfile
change; a new or missing license expression fails the release gate until reviewed.

npm 12 runs dependency install scripts only when `package.json` permits them. This release permits
only the locked `esbuild@0.28.1` and `workerd@1.20260801.1` binary setup scripts; dependency updates
must review and update those exact entries. Public CI additionally installs with `--ignore-scripts`
and builds against the platform-specific packages already present in the lockfile.

## Security patch pins — 2026-10-08

Vitest 4.1.11 addresses GHSA-82fw-gwwq-j7x9. Root npm overrides pin the
development-toolchain transitive dependencies `sharp` to 0.35.5 (Apache-2.0)
for GHSA-wq5f-xc86-pv6w and `undici` to 7.29.1 (MIT) for its security fixes,
including GHSA-w293-vg96-wgc3 and GHSA-rfgv-xxqx-mfg5. The current Miniflare
version otherwise pins Sharp 0.35.2 and Undici 7.29.0. The lockfile also
updates `source-map-js` to 1.2.2 (BSD-3-Clause) for GHSA-68fv-2mgg-jv7q,
within PostCSS's existing dependency range.

These patch updates preserve the Workers test harness and runtime versions.
They add no application runtime dependency and keep the audit threshold.

Remove an override only after the chosen upstream toolchain resolves the patched
dependency without it, and rerun the full check and browser suites.
