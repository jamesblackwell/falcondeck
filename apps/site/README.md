# FalconDeck marketing site

The public-facing FalconDeck site. It is intentionally separate from the paired remote control client in `apps/remote-web`.

The site links visitors to the [GitHub Releases page](https://github.com/jamesblackwell/falcondeck/releases) for packaged desktop downloads as releases become available.

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
