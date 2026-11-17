# Anvil — github-core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/hessaminanloo/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/hessaminanloo/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

**Anvil** is a GitHub-compatible git forge in a single Node.js process, written from
scratch against the protocol contracts — no dependencies, no install step, no git binary.
It speaks four surfaces over one shared in-memory store, so an object pushed over git is
the same object the REST contents API reads, a pull request opened over MCP is the same
pull request GraphQL merges, and ids stay stable across all of them.

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 (`ls-refs`, `fetch` with
  shallow/deepen/unshallow negotiation) and v0, plus `receive-pack` pushes with
  report-status in side-band-64k, fast-forward enforcement and thin-pack resolution.
  Git objects, SHA-1, packfile read/write (OFS/REF deltas) and pkt-line framing are all
  implemented by hand on `node:crypto` and `node:zlib`.
- **REST v3** under `/api/v3` — root and meta, the viewer, repository CRUD with
  Link-header pagination, the contents API (create/update/delete with 409 sha-conflict
  discipline), git refs, branches, commit listings, labels, issues with comments, and
  pull requests with file diffs and squash merges (405 on conflicts). Every reply is
  JSON with an `X-GitHub-Request-Id`; errors are `{message}` bodies.
- **GraphQL v4** at `/api/graphql` — a hand-written lexer/parser/executor covering the
  repository/issue/pull-request queries, cursor-paginated connections, the five
  mutations (create/close issue, create/merge pull request, add comment), batched
  operations, opaque stable global ids, and the `__type`/`__schema` introspection
  subset.
- **MCP** at `/mcp` — JSON-RPC 2.0 with the modern `server/discover` handshake (and the
  legacy `initialize` fallback), a deterministic `tools/list`, and six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) acting on the same store.

## Run it

```sh
node main.ts
```

The forge binds an ephemeral port, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`,
then long-polls `$MAKEFUN_ENV_URL/done` and exits 0 when the trial ends. Requests carry
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the token's account owns every repository
(any other owner is a 404), and `GET /healthz` answers `{"ok": true}` without auth.

State is in memory with content-addressed objects, so fetch plans are pure functions of
the object graph — repeated shallow clones of the same tip are served from a memoized
pack. Timestamps come from a logical clock seeded by `MAKEFUN_TRIAL_NOW`, keeping runs
deterministic and replayable.

## Layout

- `main.ts` — the lifecycle entrypoint: store and server wiring, registration with
  backoff, the done poll, graceful shutdown.
- `app.ts` — the HTTP front door: bearer auth, routing to the four surfaces, JSON
  404/500 discipline.
- `gitobj.ts` — the git object model: hashing, tree/commit/tag codecs, packfile
  read/write with delta resolution, pkt-lines.
- `store.ts` — the shared store: repositories, refs, issues, pulls, labels, comments,
  ancestry/merge-base walks, three-way tree merges, squash merges, line diffs.
- `githttp.ts` — smart HTTP: v0/v2 advertisements, ls-refs, fetch planning (full,
  shallow, deepen), receive-pack with per-ref report-status.
- `rest.ts` — the REST v3 surface and the JSON serializers the other surfaces reuse.
- `graphql.ts` — the GraphQL parser, executor, global ids and introspection tables.
- `mcp.ts` — the MCP JSON-RPC plumbing and tool implementations.
- `web.ts` — the shared request context and reply helpers.

## License

MIT — see `LICENSE`.
