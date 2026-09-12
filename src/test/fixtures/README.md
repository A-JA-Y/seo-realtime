# Test fixtures

## Provenance — read this before trusting a test that uses one

| File | Source | Status |
|---|---|---|
| `gsc/*.json` | **Hand-written** from Google's Search Analytics reference | ⚠️ SYNTHETIC |
| `dataforseo-live-advanced.json` | `pnpm verify:dataforseo --live` | Real, once captured |

The Search Console fixtures were written against the documented response shape,
**not captured from a live call** — the credentials to make that call did not
exist when the parser was written. They are deliberately pessimistic: they
include the shapes Google's docs leave ambiguous (bare-hour vs ISO-timestamp
`hour` keys), omitted metric fields, and zero-impression rows with no `position`.

**Replace them with real captures.** `pnpm verify:gsc --save-fixtures` writes the
genuine responses here. Until that has been run against the real property, any
test asserting on GSC response *shape* is testing an assumption, and the
`hour`-key format in particular is an open question — see `NOTES.md`.

Redact nothing but credentials. The point of a real fixture is the real shape,
including the fields an API returns inconsistently.
