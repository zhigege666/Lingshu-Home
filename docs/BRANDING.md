# Project branding

Lingshu-Home uses an ivory rounded tile with a jade folded-house mark and an open doorway. The production mark is a native SVG derived by hand from the selected project concept. It keeps the chosen shape and colors while removing raster texture and excess outer padding for small interface sizes.

## Maintained assets

| Asset | Use |
| --- | --- |
| [lingshu-home-logo.svg](../web/src/assets/lingshu-home-logo.svg) | Canonical scalable mark; interface and SVG browser icon |
| [favicon-32.png](../web/src/assets/favicon-32.png) | 32 × 32 PNG browser-icon fallback |
| [apple-touch-icon.png](../web/src/assets/apple-touch-icon.png) | 180 × 180 touch icon |
| [brand-manifest.json](../web/src/assets/brand-manifest.json) | Asset dimensions, provenance and SHA-256 values |

The PNG icons are raster exports of the canonical SVG. They are not native Windows `.ico` or macOS `.icns` application icons, and their inclusion does not implement desktop clients or installation support.

The shared `ProjectLogo` component is used for homepage identity, admin identity and About, initialization/sign-in/registration, initial loading, the no-accessible-space screen, configurable page branding and its editor. Generic navigation/category icons remain separate from the project mark.

## Theme and layout rules

- Preserve the ivory tile and jade colors in light and dark themes. Do not apply the monochrome filter used by navigation icons.
- Reserve the image's width and height before it loads. The image is decorative when a neighboring project name or an accessible home-link label already supplies its name.
- Keep the mark and project name together when footer content wraps. Version text can wrap separately.
- The default page branding stays in the footer's right slot. Moving or removing the branding item applies to the logo, name and version together; the renderer does not reinsert a removed item.
- Read-only layout previews use the same component and asset as the actual homepage.

Vite emits the three referenced images under content-derived `/assets/` URLs. Both browser-icon links and the component reference the emitted files, so a changed asset receives a changed URL. Images use the server's existing `no-cache` revalidation; the immutable JavaScript/CSS cache policy is unchanged. No external icon request is needed.

The build references only the production files above. Private concepts and comparison material are excluded from Git, frontend assets, Docker context and release packages. The original project artwork follows the repository's [Apache-2.0 license](../LICENSE); third-party assets retain their own licenses, and the project name/mark do not imply endorsement of other products.

## 简体中文

项目使用乳白圆角底板、玉绿色折带房屋和开放门洞的 Logo。运行文件是按选定概念稿整理的原生 SVG，保留主要造型和颜色，去掉纹理与过多外边距；32 像素 favicon 和 180 像素触屏图标由同一 SVG 导出。

首页、后台、登录/初始化、加载状态、页眉页脚品牌项及其编辑预览共用此图标。浅色和深色主题都保留原配色，图片提前占位；页脚默认仍在右下，图标与名称保持在一起，品牌项可以整体移动或删除。通用分类图标继续使用原有图标库。

更新时同步三份公开运行资产及校验记录，再重新构建；引用会随内容生成新的资源地址。概念原稿及相似性研究保持私有，不作为运行图片打包。这里提供的是 Web 品牌图标，不代表原生 Windows/macOS 客户端图标或安装包已经实现。
