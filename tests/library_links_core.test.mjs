import test from 'node:test'
import assert from 'node:assert/strict'
import { documentRelativePath, documentAssetURL, isMarkdownPath, safeExternalLink, markdownDisplayBody } from '../web/src/library/links.ts'

test('Markdown relative links stay inside the registered directory', () => {
  assert.equal(documentRelativePath('operations/deploy.md', '../images/check.png'), 'images/check.png')
  assert.equal(documentRelativePath('operations/deploy.md', './nested/README.md#准备'), 'operations/nested/README.md')
  assert.equal(documentRelativePath('operations/deploy.md', '中文%20说明.markdown'), 'operations/中文 说明.markdown')
  for (const unsafe of ['../../secret.txt', '%2E%2E/%2E%2E/secret', '/etc/passwd', '//example.invalid/x', 'file:///etc/passwd', 'https://example.invalid/x', '..\\secret', '%5csecret', '%00secret', '%zz']) {
    assert.equal(documentRelativePath('operations/deploy.md', unsafe), null, unsafe)
  }
})
test('attachments use the authorized document endpoint; active links are rejected', () => {
  assert.equal(documentAssetURL('space', 'doc', 'image%20name.png'), '/api/v1/spaces/space/documents/doc/asset?path=image%20name.png')
  assert.equal(documentAssetURL('space', 'doc', '../image.png?x=1#part'), '/api/v1/spaces/space/documents/doc/asset?path=..%2Fimage.png')
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,<script/>', 'file:///tmp/a', '//example.invalid', '#fragment']) assert.equal(safeExternalLink(unsafe), undefined)
  assert.equal(safeExternalLink('https://example.invalid/docs'), 'https://example.invalid/docs')
  assert.equal(isMarkdownPath('readme.MD'), true)
  assert.equal(isMarkdownPath('readme.md.exe'), false)
})
test('front matter is omitted only from presentation; original source is retained', () => {
  const source = '\uFEFF---\r\ntitle: Example\r\ncustom: keep\r\n---\r\n# Body\r\n'
  assert.equal(markdownDisplayBody(source), '# Body\r\n')
  assert.ok(source.includes('custom: keep'))
  assert.equal(markdownDisplayBody('# Body\n---\n'), '# Body\n---\n')
})
