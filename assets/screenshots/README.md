# Application screenshots

Captured on 2026-10-18 from the React/Go development application, version `0.1.0-dev.1`, in independent Chromium sessions with public example data. The four current captures show the iOS inspired theme, dedicated visual composer and mobile editing canvas. The earlier five logo/layout, four composition and six compact-admin captures remain available as historical examples. Internal design documents and visual explorations are not included.

Desktop browser viewports were **2560 × 1440 CSS pixels**, with device scale factor 1; the current mobile capture is **390 × 844**. Historical full-page captures retain content below the viewport where noted; they do not shrink the application to fit one screen. All PNGs were saved directly by the browser without image post-processing.

## Current visual composer and iOS theme

| File | Image pixels | Screen |
| --- | --- | --- |
| [home-ios-en-2k.png](home-ios-en-2k.png) | 2560 × 1440 | English iOS inspired homepage after a real page save and full document reload |
| [home-ios-zh-CN-2k.png](home-ios-zh-CN-2k.png) | 2560 × 1440 | Chinese iOS inspired homepage with app-icon groups, bounded favorites and custom left footer |
| [home-editor-ios-zh-CN-2k.png](home-editor-ios-zh-CN-2k.png) | 2560 × 1440 | Reopened editor with a clean saved draft, component layers, selectable canvas, empty header slots and two theme choices |
| [home-editor-mobile-zh-CN-390.png](home-editor-mobile-zh-CN-390.png) | 390 × 844 | Mobile edit draft with top category navigation; component/property drawers are closed to show the canvas |

These captures come from [browser_visual_composer.cjs](../../tests/browser_visual_composer.cjs), running against isolated Chinese and English demo copies on ports **5184** and **5185**. Each language passed **eight workflow groups**. In its one deliberate UI save, the script switches to iOS, adds another favorites component labelled Quick access and inserts plain footer text. This component references the existing three favorites; no additional bookmark records are created. The script then calls **`page.reload()`**, compares the complete saved configuration with an independently constructed expectation, and captures the published desktop views at page revision **36 (Chinese)** or **46 (English)**.

Cleanup restores each original page name and complete configuration, including the original absence of custom `chrome`, at revisions **37** and **47**. All original fields of the 43 links, eight categories and three favorites are preserved. The mobile image comes from the earlier unsaved draft phase; its category position and appearance are canceled, and it must not be described as a saved configuration. Dark screenshots also exist in the private evidence, but these four public files are the selected captures.

The ordinary header is absent from the editor and returns in visitor preview. Empty or disabled header/footer slots appear as editing targets only. The screenshot's large canvas can scroll independently of the fixed toolbars. Existing bookmark and category names remain unchanged when the instance language differs. No actual GitHub Traffic statistics, private accounts or integration credentials appear in these images.

中文说明：这四张为本轮真实运行截图。桌面图拍于实际保存并整页刷新后的中文 revision 36、英文 revision 46；随后恢复原配置至新修订 37、47。新增“快速访问”组件复用原收藏，不复制书签。390 px 手机图来自稍早的未保存草稿。图中的灰色空页眉槽位只在编辑时显示，左侧为页面结构，右侧为当前对象的属性；前台普通头部在编辑模式中收起。

## Historical branding and layout captures

| File | Image pixels | Screen |
| --- | --- | --- |
| [home-brand-light-2k.png](home-brand-light-2k.png) | 2560 × 1440 | Light homepage: three small categories share a row, larger categories fill their rows, and all 43 links fit in the viewport |
| [home-brand-dark-2k.png](home-brand-dark-2k.png) | 2560 × 1440 | Dark homepage with the same layout and original logo colors |
| [home-edit-fit-2k.png](home-edit-fit-2k.png) | 2560 × 1440 | Six editor controls fill one row; navigation already uses saved content height, so the draft reports no changes |
| [admin-brand-preview-2k.png](admin-brand-preview-2k.png) | 2560 × 1440 | The admin workspace and its actual 2560 × 1440 homepage preview share the project mark |
| [home-brand-en-2k.png](home-brand-en-2k.png) | 2560 × 1440 | English homepage after an actual Fit content save and full document reload |

The four Chinese captures use demo port **5182** at page revision **35**. Before this read-only capture run, the requested layout correction was deliberately saved once (`34 → 35`): only the navigation panel's `h:27 → 3` and `heightMode:fixed → content` changed. That correction is separate from the browser acceptance, which performed **zero writes**, retained revision 35 and preserved the complete page DTO and all navigation records. The homepage editor image shows the already-saved content-height layout; clicking Fit content does not create a new difference.

The English main image comes from the isolated English clone on **5183**, started with `--language en`. Its guarded acceptance performs one real UI save (`43 → 44`), calls Playwright's **`page.reload()` for a full document HTTP reload**, and captures this image at revision **44** after confirming the persisted content height. Cleanup then restores the original name and complete configuration at a new revision, **45**. The first nine diagnostic captures in that run precede the save; the published English image is its tenth capture and must not be described as a zero-write capture session. The earlier same-hash navigation check is not used as evidence of a full reload.

Final browser acceptance passed **192 Chinese** and **218 English** assertions, with no unapproved requests, JavaScript errors, console errors or native dialogs. It includes actual logo loading and dimensions, favicon responses, sparse-category alignment, filled card rows, bounded favorites, draft/cancel behavior, the real sandboxed preview and 390 px overflow checks. Exact write boundaries and execution records are in [tests/README.md](../../tests/README.md).

## Earlier composition and preview captures

| File | Image pixels | Screen |
| --- | --- | --- |
| [admin-live-preview-2k.png](admin-live-preview-2k.png) | 2560 × 1440 | Layout controls beside the actual homepage rendered at a logical 2560 × 1440 viewport |
| [home-edit-mode-2k.png](home-edit-mode-2k.png) | 2560 × 1440 | Homepage edit mode with real grid handles and an unsaved panel-spacing change |
| [admin-header-footer-2k.png](admin-header-footer-2k.png) | 2560 × 1440 | Footer editor: text at the left, a documentation link at the center and project branding at the right |
| [home-en-2k.png](home-en-2k.png) | 2560 × 1440 | English instance interface with existing bookmark and category names preserved |

The three Chinese captures use the dedicated demo on port **5182**. The English capture uses an isolated copy on port **5183**, started with `--language en`. Interface language does not translate or replace stored user content, so existing example category names may still be Chinese. Preview frames suppress navigation and writes; the screenshot's documentation URL is a public repository URL and was not visited.

**These four captures performed no saves.** The editor and footer changes existed only as drafts and were cancelled. The capture session blocked all write requests and reported zero writes and zero browser errors. Full page DTOs, navigation data fields and navigation revisions matched the initial reads. The Chinese demo retained page revision **34** and the English demo retained **39**; the English clone's earlier deliberate save/restore checks are separately recorded in [tests/README.md](../../tests/README.md).

The same read-only session checked the normal service's short homepage: the footer ended at 1,440 px and its branding occupied the right slot. A temporary content-height draft in the demo's preview produced a 1,576 px document, with its footer bottom at 1,575.5 px. The ordinary-service screenshot remains a private verification record, separate from these four public examples.

## Earlier compact-admin captures

| File | Image pixels | Screen |
| --- | --- | --- |
| [home-cards-2k.png](home-cards-2k.png) | 2560 × 1575 | Light grouped cards with compact homepage controls; full page |
| [home-directory-dark-2k.png](home-directory-dark-2k.png) | 2560 × 1440 | Dark directory variant |
| [admin-layout-2k.png](admin-layout-2k.png) | 2560 × 1440 | Built-in page, appearance and category-position settings |
| [admin-links-2k.png](admin-links-2k.png) | 2560 × 1440 | Compact link management with local table scrolling and pagination |
| [admin-category-settings-2k.png](admin-category-settings-2k.png) | 2560 × 1440 | Selected category component inspector, display mode, hierarchy and collapse settings |
| [home-category-icons-2k.png](home-category-icons-2k.png) | 2560 × 1575 | Homepage with icon-only category navigation; full page |

## Example data and reproduction

The disposable demo contains **43 public links** from the built-in samples and [demo-bookmarks.html](../../tests/fixtures/demo-bookmarks.html), with eight categories. Favorite references can appear in both the favorites panel and their original navigation categories; they do not create additional link records. No personal bookmarks, accounts, tokens or real GitHub Traffic statistics appear in these captures.

[browser_smoke.cjs](../../tests/browser_smoke.cjs) verifies bookmark import and page controls through the UI. [browser_refinement.cjs](../../tests/browser_refinement.cjs) covers the compact admin workspace, styled forms, category modes and real horizontal category scrolling. [browser_layout.cjs](../../tests/browser_layout.cjs) verifies responsive geometry and mouse layout persistence. The current [form checks](../../tests/browser_chrome_refinement.cjs), [composition checks](../../tests/browser_composition.cjs) and [editor boundary checks](../../tests/browser_edit_boundaries.cjs) cover language, focus, live previews and draft/save behavior. Their execution records are separate from the capture sessions. Run them only against the explicitly allowed, disposable ownerless `open_edit` demos; instructions are in [tests/README.md](../../tests/README.md).

To reproduce the views, use a 2560 × 1440 viewport, open the relevant admin section, and select the desired homepage appearance or category display mode. For the full-page navigation captures, the navigation panel was temporarily set to content height so all example links appeared in the page capture. Category settings are under **布局与主题 → 积木与数据绑定**, after selecting the category-navigation component.

**The earlier six-image capture session performed real page saves.** Presentation settings were temporarily saved for those screenshots, including the navigation panel's content height and category appearance. After those captures, the original complete page configuration was restored and read back successfully at revision **34**. The link and category records remained unchanged. The restored revision is a record of that session; restoring configuration does not roll a page revision backward. The earlier six screenshots must not be described as the result of a zero-write capture run.

The five historical branding/layout captures use the project's bundled house logo; its source, sizes and theme behavior are described in [BRANDING.md](../../docs/BRANDING.md). The ten earlier captures predate this integration and show the temporary Compass/wordmark. Original application work follows the repository's Apache-2.0 license; third-party components and icons retain the licenses recorded in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

历史 Logo/布局图片说明：该轮五张均为 2560 × 1440 的真实运行截图，已接入房屋 Logo，并展示小分类并排、卡片行铺满、内容高度、编辑控件铺满和实际首页预览。中文演示先单独保存布局修正到 revision 35，再进行零写入拍摄；编辑图为已保存内容高度下的“未修改”状态。英文主图来自一次真实 UI 保存后的 revision 44，并明确执行整页 HTTP 重载，随后恢复全部原配置到新 revision 45。该轮两端验收分别通过 192、218 个断言，书签和分类字段均保留。前四张组合编辑截图和更早六张紧凑后台截图也保留为历史记录，各自的保存与恢复范围见对应小节。界面语言不会改写现有书签正文或分类名称；截图不含内部设计稿、个人数据或真实 GitHub Traffic 统计。
