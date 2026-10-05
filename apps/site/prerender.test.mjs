import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// Run after `npm run build --workspace falcondeck-site`.
const output = new URL('./dist/', import.meta.url)

test('published pages contain readable content and route-specific metadata', async () => {
  for (const [file, path, title] of [
    ['index.html', '/', 'Your coding agents.'],
    ['privacy/index.html', '/privacy', 'Privacy Policy'],
    ['terms/index.html', '/terms', 'Terms of Use'],
  ]) {
    const html = await readFile(new URL(file, output), 'utf8')
    assert(html.includes(`data-prerender-path="${path}"`))
    assert(html.includes('<h1'))
    assert(html.includes(title))
    assert(html.includes(`rel="canonical" href="https://falcondeck.com${path}"`))
    assert(html.includes('https://apps.apple.com/app/falcondeck/id6760899257'))
    assert.match(html, /src="\/assets\/[^" ]+\.js"/)
  }
})

test('discovery files have real content and exclude pairing', async () => {
  const robots = await readFile(new URL('robots.txt', output), 'utf8')
  const sitemap = await readFile(new URL('sitemap.xml', output), 'utf8')
  assert(robots.includes('Disallow: /pair'))
  assert(robots.includes('Sitemap: https://falcondeck.com/sitemap.xml'))
  assert(sitemap.includes('<urlset'))
  assert(sitemap.includes('<loc>https://falcondeck.com/</loc>'))
  assert(!sitemap.includes('/pair'))
})
