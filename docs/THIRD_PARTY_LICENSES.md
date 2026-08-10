# Third-Party Licenses

## Runtime

The application bundle has no runtime npm dependency. It uses browser standards and Cloudflare
platform APIs supplied by the deployer's environment.

## Direct development dependencies

| Package | Version | License |
|---|---:|---|
| `@cloudflare/vitest-pool-workers` | 0.20.3 | MIT |
| `@types/node` | 24.13.3 | MIT |
| `typescript` | 7.0.2 | Apache-2.0 |
| `vitest` | 4.1.10 | MIT |
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
