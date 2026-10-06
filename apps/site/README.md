# FalconDeck marketing site

The public-facing FalconDeck site. It is intentionally separate from the paired remote control client in `apps/remote-web`.

The Mac download buttons start the Apple Silicon DMG download directly, with a
separate Intel Mac link below the main button. GitHub hosts the files through
`releases/latest/download/FalconDeck_{aarch64,x64}.dmg`; visitors stay on the
site instead of browsing release assets. The desktop release workflow publishes
these stable filenames as exact copies of the versioned, signed installers, so
the site follows the latest published release without a rebuild.

The site links to the [App Store](https://apps.apple.com/app/falcondeck/id6760899257)
for the free iPhone and iPad app. The `/pair` page opens existing pairing links
and provides the App Store download for new users.

## Run locally

From the monorepo root:

```bash
npm run dev --workspace falcondeck-site
```

The site runs at [http://localhost:4175](http://localhost:4175).

## Build

```bash
npm run build --workspace falcondeck-site
```

The build renders the homepage, privacy policy, and terms to static HTML, then
hydrates the matching page in the browser. Pairing links still open the client
pairing screen, including legacy `/?code=…` links. No production rendering server
is required. `robots.txt`, `sitemap.xml`, and the branded share image are published
with the bundle.

Check the generated pages after building:

```bash
node --test apps/site/prerender.test.mjs
```
