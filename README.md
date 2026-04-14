# enrich

Small CLI to crawl a company/site domain and extract the best contact plus top social links.

Repo: `github.com:traikker/enrich.git`

## Requirements

- [Bun](https://bun.sh) (project uses `bun@1.2.11`)
- Node `v24.14.1` (see `.nvimrc` in this repo)

## Install

```bash
nvm use
bun install
```

## Run

```bash
bun run src/enrich.ts <url>
```

Example:

```bash
bun run src/enrich.ts https://example.com
```

## Output

The command prints JSON like:

```json
{
  "domain": "example.com",
  "contact": {
    "name": "...",
    "title": "...",
    "email": "...",
    "score": 0.91,
    "reasons": ["..."]
  },
  "socials": {
    "facebook": "...",
    "instagram": "...",
    "linkedin": "...",
    "x": "...",
    "tiktok": "..."
  },
  "endpointsSearched": 18
}
```

Notes:
- `contact` may be `null` if nothing reliable is found.
- `socials` are returned at the top level (not under `contact`).
- `endpointsSearched` is a count only.

## Scripts

- `bun run start -- <url>` or `bun run src/enrich.ts <url>`
- `bun run build` – TypeScript build
- `bun run check` – typecheck only
