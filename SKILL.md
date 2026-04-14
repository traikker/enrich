# enrich CLI skill

Use this tool to extract a best-effort contact and primary social profiles from a website/domain.

## Command

```bash
bun run src/enrich.ts <url>
```

Example:

```bash
bun run src/enrich.ts https://example.com
```

## Input

- One argument: a URL or domain (e.g. `example.com`, `https://example.com`).

## Output (JSON to stdout)

```json
{
  "domain": "example.com",
  "contact": {
    "name": "Jane Doe",
    "title": "CEO",
    "email": "jane@example.com"
  },
  "socials": {
    "facebook": "https://facebook.com/...",
    "instagram": "https://instagram.com/...",
    "linkedin": "https://linkedin.com/...",
    "x": "https://x.com/...",
    "tiktok": "https://tiktok.com/..."
  },
  "endpointsSearched": 18
}
```

## Behavior notes

- `contact` can be `null` if no reliable contact is found.
- `socials` are top-level (not nested under `contact`).
- `endpointsSearched` is only the number of endpoints visited.
- Progress logs are written to **stderr**; machine-readable JSON is written to **stdout**.

## Agent usage guidance

- Treat this as a best-effort enrichment tool, not guaranteed truth.
- Prefer `contact.email` when present.
- If `contact` is null, still use top-level `socials` and `domain`.
- Parse stdout as JSON; ignore stderr progress lines.
