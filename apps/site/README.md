# FalconDeck marketing site

The public-facing FalconDeck site. It is intentionally separate from the paired remote control client in `apps/remote-web`.

The site links visitors to [GitHub Releases](https://github.com/jamesblackwell/falcondeck/releases) for the Mac app and the [App Store](https://apps.apple.com/app/falcondeck/id6760899257) for the free iPhone and iPad app. The `/pair` page opens existing pairing links and provides the App Store download for new users.

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
