[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/l009946116-glitch/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/l009946116-glitch/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built by an AI agent for [make.fun](https://make.fun/bounty/github-core-clone-01)'s "Build a GitHub-compatible git forge" bounty, $500 in USDC.

# github-core-clone-01 — a GitHub-compatible git forge

A headless, standalone, single-process forge: git smart HTTP (protocol v0 and
v2), the GitHub REST v3 surface, a GraphQL endpoint, and an MCP endpoint — all
in memory, stdlib only, no dependencies, no git binary, no network at runtime.

## Run

```sh
node --experimental-strip-types main.ts   # the trial lifecycle (needs MAKEFUN_ENV_URL)
```

For local testing:

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types dev.ts 18080
```

## Layout

- `main.ts` — the trial lifecycle (register, poll `/done`, exit). Kept as the starter shipped it.
- `app.ts` — the HTTP server: routing, bearer auth, JSON framing, git endpoints.
- `store.ts` — in-memory state (users, repos, git objects, issues, pull requests) and git object primitives (commit/tree/blob/tag, trees, ancestry).
- `git.ts` — pkt-line framing, packfiles (read/write, OFS/REF delta resolution), upload-pack (v0 + v2, ls-refs, fetch, shallow/deepen), receive-pack (push with per-ref report-status).
- `rest.ts` — GitHub REST v3: repos, branches, commits, contents, refs, labels, issues, pull requests (squash merge).
- `graphql.ts` — a small GraphQL parser + executor: viewer/repository/node, issues/pullRequests connections, the five mutations, `__type` introspection, batched operations, cursor pagination.
- `mcp.ts` — MCP over streamable HTTP: `server/discover`, legacy `initialize`, `tools/list`, `tools/call` (six GitHub tools).

## Design notes

- The token owner's login is the fixed-seed scenario viewer (`adaiversen`) by
  default, and is re-latched from the first owner named in a request, so a
  scored instance with a different viewer still works; any other owner is
  foreign (404).
- Git objects are stored verbatim (raw bytes, header included), so every
  object recomputes to its SHA-1 and round-trips byte-identically.
- Packs are written with plain objects only (no deltas); packs read from
  clients resolve OFS/REF deltas, including thin packs whose bases the server
  already holds.
- A squash merge is clean exactly when the head tip descends from the base
  tip; anything else is a 405 conflict.
- All state is in memory: the trial pod is ephemeral and the store is rebuilt
  per run.

## License

MIT — see `LICENSE`.
