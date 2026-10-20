import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
const root = fileURLToPath(new URL('..', import.meta.url))
const iconRoot = resolve(root, 'assets/icons')
function icons(): Plugin {
  return { name: 'bundled-navigation-icons', generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'icons/manifest.json', source: readFileSync(resolve(iconRoot, 'manifest.json')) })
    for (const name of readdirSync(resolve(iconRoot, 'lucide'))) if (/^[a-z0-9-]+\.svg$/.test(name)) this.emitFile({ type: 'asset', fileName: `icons/lucide/${name}`, source: readFileSync(resolve(iconRoot, 'lucide', name)) })
  } }
}
function compressedAssets(): Plugin {
  return { name: 'precompressed-static-assets', enforce: 'post', writeBundle(options, bundle) {
    if (!options.dir) return
    // Read final files after the bundler replaces chunk-hash placeholders.
    for (const fileName of Object.keys(bundle)) {
      if (!/\.(js|css)$/.test(fileName)) continue
      const path = resolve(options.dir, fileName)
      const input = readFileSync(path)
      const compressed = gzipSync(input, { level: 9 })
      if (input.length >= 1024 && compressed.length < input.length) writeFileSync(`${path}.gz`, compressed)
    }
  } }
}
export default defineConfig({
  plugins: [react(), tailwindcss(), icons(), compressedAssets()],
  define: { __APP_VERSION__: JSON.stringify(readFileSync(resolve(root, 'VERSION'), 'utf8').trim()) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:5180', '/icons': 'http://127.0.0.1:5180', '/mcp': 'http://127.0.0.1:5180' } },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 }
})
