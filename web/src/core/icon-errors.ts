import { ApiError, messageOf } from './api'
import { t } from './i18n'

// These exact messages are emitted by the icon endpoints and their shared URL
// and metadata validators. Do not translate arbitrary server messages by regex:
// a new error must remain visible as returned until its meaning is known.
const validationMessages: Record<string, string> = {
  'An imported icon must belong to the current space.': '导入的图标必须属于当前空间。',
  'Import or fetch the icon in this space before using it.': '请先在当前空间导入或获取这个图标，再使用它。',
  'A space can retain at most 1024 custom icons and 32 MiB of image content.': '每个空间最多保存 1024 个自定义图标，图片总大小不得超过 32 MiB。',
  'An icon pack requires schemaVersion 1 and 1 to 64 icons.': '图标库须使用 Schema 1，并包含 1–64 个图标。',
  'A space may contain at most 32 imported icon packs.': '每个空间最多导入 32 个图标库。',
  'Icon keys must be unique lowercase names of at most 64 characters.': '图标标识必须唯一，使用小写名称，且不超过 64 个字符。',
  'Each encoded icon exceeds the 256 KiB limit.': '单张图标超过 256 KiB 限制。',
  'Icon content must be standard base64 without a data URL prefix.': '图标内容须为标准 Base64，不得包含 data URL 前缀。',
  'An icon pack may contain at most 4 MiB of decoded images.': '每个图标库解码后的图片总大小不得超过 4 MiB。',
  'Each icon must contain 1 to 262144 bytes.': '单张图标须为 1–262144 字节，最多 256 KiB。',
  'Use a valid PNG or JPEG icon with dimensions from 1 to 512 px.': '请使用有效的 PNG 或 JPEG 图标，宽高须为 1–512 像素。',
  'Icons support PNG, JPEG, or a static geometry-only SVG.': '图标仅支持 PNG、JPEG，或只包含几何图形的静态 SVG。',
  'The icon could not be decoded or contains unsupported SVG content.': '无法解码图标，或 SVG 包含不支持的内容。',
  'The normalized icon exceeds 262144 bytes; use a smaller image.': '处理后的图标超过 256 KiB，请使用更小的图片。',
  'A space may cache at most 512 website origins.': '每个空间最多缓存 512 个网站来源的图标。',
  'Icon pack name is required and exceeds no more than 80 characters.': '请填写图标库名称，最多 80 个字符。',
  'Icon pack name must not contain control characters.': '图标库名称不能包含换行、制表符等控制字符。',
  'Icon license or ownership notice is required and exceeds no more than 2048 characters.': '请填写图标许可或权属说明，最多 2048 个字符。',
  'Icon license or ownership notice must not contain control characters.': '图标许可或权属说明不能包含换行、制表符等控制字符。',
  'Icon label is required and exceeds no more than 80 characters.': '请填写图标名称，最多 80 个字符。',
  'Icon label must not contain control characters.': '图标名称不能包含换行、制表符等控制字符。',
  'Invalid website URL.': '网站网址无效。',
  'Website address is blocked or invalid.': '网站地址无效，或属于禁止访问的地址。',
  'Only the original website hostname may use a private network address.': '仅最初指定的网站主机允许使用内网地址。',
  'Invalid website hostname.': '网站主机名无效。',
  'URL must be valid UTF-8 and at most 4096 bytes.': '网址须使用有效的 UTF-8 编码，且不超过 4096 字节。',
  'URL must not contain whitespace, control characters or backslashes.': '网址不能包含空白、控制字符或反斜杠。',
  'URL must be an absolute HTTP or HTTPS address without embedded credentials.': '网址须为完整的 HTTP 或 HTTPS 地址，不能内嵌用户名或密码。',
  'Only HTTP and HTTPS URLs are supported.': '网址仅支持 HTTP 或 HTTPS。',
  'URL port must be between 1 and 65535.': '网址端口须为 1–65535。',
  'URL hostname is invalid.': '网址中的主机名无效。',
}

const operationMessages = [
  { status: 422, code: 'favicon_unavailable', message: 'No supported website icon was found. Choose a built-in icon or import an image.', chinese: '未找到支持的网站图标，请选择内置图标或导入图片。' },
  { status: 422, code: 'favicon_unavailable', message: 'No supported website icon was found recently. Retry after the cache expires or import an image.', chinese: '最近未找到支持的网站图标，请在缓存过期后重试，或直接导入图片。' },
  { status: 429, code: 'icon_fetch_busy', message: 'A website icon is being fetched. Try again shortly.', chinese: '已有网站图标正在获取，请稍后重试。' },
  { status: 409, code: 'conflict', message: 'Replace icons used by links, categories, pages or source snapshots before deleting this pack.', chinese: '图标库仍被链接、分类、页面或数据源使用。请先替换引用，再删除图标库。', english: 'This library is still used by links, categories, pages or sources. Replace those references before deleting it.' },
] as const

/** Presentation only: the original ApiError status, code and details stay intact. */
export function iconErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return messageOf(error)
  if (error.status === 400 && error.code === 'validation_error') {
    const translated = validationMessages[error.message]
    if (typeof translated === 'string') return t(translated, error.message)
  }
  const known = operationMessages.find(entry => entry.status === error.status && entry.code === error.code && entry.message === error.message)
  if (known) return t(known.chinese, 'english' in known ? known.english : error.message)
  return messageOf(error)
}
