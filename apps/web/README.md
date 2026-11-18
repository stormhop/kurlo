# Kurlo web (landing + docs)

Astro Starlight project that powers the public Kurlo site:

- `/` — the marketing landing, a standalone Astro page (`src/pages/index.astro`, styles in `src/styles/landing.css`) outside Starlight. Its cropped showcase images in `src/assets/landing/` come from `node scripts/gen-landing-images.mjs`.
- `/download/` — installer matrix for macOS / Windows / Linux.
- `/docs/...` — full documentation: getting started, guides, reference, FAQ.
- `/changelog/` — notable changes plus a link to tag-specific release notes; `/changelog/v1/` keeps the 1.x notes.

## Local development

From the repo root:

```sh
npm install            # installs all workspaces, including apps/web
npm run web:dev        # starts Astro dev server on http://localhost:4321
```

Or from this directory:

```sh
npm install
npm run dev
```

## Build

```sh
npm run web:build      # outputs to apps/web/dist/
npm run web:preview    # serves the production build locally
```

## Deploy

`kurlo.dev` is served by nginx on a VPS behind Cloudflare. `.github/workflows/web-deploy.yml` builds the site and rsyncs it into a timestamped release directory, then flips a symlink, so publishing is atomic. It runs on every push to `main` that touches `apps/web/**`, and reads the host, the deploy key and the pinned host key from Actions secrets — nothing about the origin server is stated in this repository.

Provisioning, the nginx site, TLS issuance and rollback live in the private `stormhop/infra` repository, which also has a `publish.sh` for deploying from a workstation.

### Where the domain lives

`site.config.mjs` holds `PRIMARY_DOMAIN` and everything derived from it — `site.astro.mjs`, the structured data and `src/pages/robots.txt.ts` all read from there, so moving the site is one line plus DNS.

`KURLO_SITE_URL` and `KURLO_SITE_BASE` override it at build time for staging. Empty values count as unset, which matters because GitHub Actions passes an unconfigured repository variable through as an empty string.

## Maintenance notes

- Keep `src/content/docs/changelog.md` aligned with the notable changes in the root `CHANGELOG.md`; exact per-tag notes live in `stormhop/kurlo` releases.
- Keep installation/signing language aligned with `.github/workflows/release.yml`. Update signatures and installer signatures are separate concerns.
- Update `DOCS_COVERAGE.md` whenever a user-facing feature, setting, limit, or screenshot changes.
- Replace empty-state screenshots with populated workflows as the screenshot pass progresses.

## Project structure

```
apps/web/
├── astro.config.mts          # Astro entry point
├── site.astro.mjs            # Starlight config and navigation file watcher
├── src/
│   ├── assets/               # in-repo images referenced from MDX
│   ├── content.config.ts     # Starlight content collection loader
│   ├── content/docs/
│   │   ├── index.mdx         # /  splash landing
│   │   ├── download.mdx      # /download
│   │   ├── changelog.md      # /changelog — 2.x
│   │   ├── changelog/v1.md   # /changelog/v1 — 1.x archive
│   │   └── docs/             # /docs/* — actual documentation tree
│   └── styles/custom.css     # brand tokens, splash refinements
└── public/                   # static files served as-is
```

## Notes on the docs subtree

Starlight is mounted at the site root. Documentation lives under `src/content/docs/docs/`. For example, `getting-started/installation.mdx` serves `/docs/getting-started/installation/`, and `getting-started/installation/macos.mdx` serves the macOS article.

`docs.sidebar.mjs` defines the areas and their groups. `docs.topics.mjs` lists the articles in each guide in sidebar order. When moving a published heading, update its entry in `docs.legacy-fragments.json` so old links lead to the new article.
