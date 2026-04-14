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
    "email": "..."
  },
  "socials": {
    "facebook": "...",
    "instagram": "...",
    "linkedin": "...",
    "x": "...",
    "tiktok": "..."
  },
  "endpointsSearched": 18,
  "createdDate": "2026-04-14T16:07:22.123Z"
}
```

Notes:
- `contact` may be `null` if nothing reliable is found.
- `socials` are returned at the top level (not under `contact`).
- `endpointsSearched` is a count only.
- `createdDate` is the completion timestamp in RFC3339 format.

## Scripts

- `bun run start -- <url>` or `bun run src/enrich.ts <url>`
- `bun run build` – TypeScript build
- `bun run check` – typecheck only
