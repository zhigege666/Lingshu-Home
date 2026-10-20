# Third-party notices

The Apache-2.0 license at the repository root applies to original Lingshu-Home work. It does not replace the licenses of third-party assets listed below.

## Lucide icons

- Upstream: https://github.com/lucide-icons/lucide
- Pinned revision: `1ef60af944de207e0d5176905a0759ba12e6ee8d`
- Files: 30 unmodified SVGs under `assets/icons/lucide/`, enumerated in `assets/icons/manifest.json`.
- Original license: [assets/icons/licenses/lucide-LICENSE](assets/icons/licenses/lucide-LICENSE).
- The complete upstream license file contains Lucide's ISC notice and the MIT notice for icons derived from Feather. Keep the full file with redistributed copies; this project does not relabel the icons as Apache-2.0 or as an optional choice of licenses.
- Original license source: https://raw.githubusercontent.com/lucide-icons/lucide/1ef60af944de207e0d5176905a0759ba12e6ee8d/LICENSE
- Modifications: none. Localized display names, search keywords and fallback mappings in the manifest are Lingshu-Home metadata.

## Brand icons and design concepts

The initial built-in SVG pack contains generic UI and category icons. It does not bundle third-party product logos. A product name mapped to a generic fallback is not a representation that the fallback is that product's official logo.

Future brand assets must retain their own source, asset license, attribution, guidelines, permitted use and modification records. A general icon collection's license does not automatically settle the rights to each brand mark; see [Simple Icons' disclaimer](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md).

UI concept images may illustrate familiar application identities. They are design references, not the source of redistributable brand SVGs. Current application branding uses a temporary generic Compass and wordmark. No third-party brand SVGs or private design images are bundled.

## REUI public components

- Upstream: https://github.com/keenthemes/reui
- Pinned revision: `067aa0dc7f8bbfec1cd76fc5ad31f842be5f569a`.
- Original MIT license and file provenance: `web/vendor/reui/LICENSE.md` and `web/vendor/reui/manifest.json`.
- Seven public components are adapted in `web/src/components/ui/`: Button, Dialog, Input, Label, Table, Tabs, and Textarea. Original upstream files and original/adapted hashes are retained in the vendor record.
- Changes adapt local imports, the dialog close icon, and Tabs orientation/state attributes for this application's Radix and Tailwind setup. No REUI Pro assets are included.

## Frontend dependencies

React, Radix UI, React Grid Layout, Lucide React and the build dependencies keep the licenses shipped by their respective packages. `scripts/collect_node_licenses.mjs` collects original notice files, records package versions and SHA-256 hashes, and separates runtime dependencies from build-only packages. The generated manifest is included in the application image and Linux bundle under `licenses/npm/`.

The npm package `react-remove-scroll-bar@2.3.8` declares MIT but does not ship a LICENSE file. Its original upstream MIT notice is retained at the fixed license commit recorded in `web/vendor/dependency-notices/manifest.json`, with a SHA-256 check. Missing notices for non-shipped build-only platform bindings are recorded explicitly; missing runtime notices fail the build.

## Go runtime and server modules

`scripts/collect_go_licenses.go` uses the actual server dependency graph and copies original module notices, plus the Go distribution and available vendor notices. The resulting `licenses/go/manifest.json` lists files and hashes. Unreferenced test/build modules are outside that shipped graph.

The Go 1.26.8 BSD license is also retained in `assets/licenses/go/` with its official source and checksum for packaged toolchains that omit the root GOROOT notice. This fallback is accepted only for the matching Go runtime version and original file hash. Third-party notices are not relicensed under Apache-2.0.
