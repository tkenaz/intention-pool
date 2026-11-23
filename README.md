# Intention Pool

An MCP server that gives an AI agent a durable place to keep **what it is trying to do**:
goals that carry a priority signal, change over time, and leave a full,
tamper-resistant record of which model changed what.

It is backed by PostgreSQL with pgvector. Embeddings are computed locally, so no
intention text leaves the machine.

## Why not a task list

A task list answers "what is left to do". An agent that works across many sessions
needs answers to different questions:

| Question | What Intention Pool stores |
|---|---|
| What matters most right now? | **Energy**: a 0–1 value per intention that the agent raises and lowers as work progresses |
| How did this goal get to its current wording? | **Evolution history**: every rewrite keeps the previous content, energy and a note |
| What actually happened along the way? | **Journey**: milestones, progress entries, insights, blockers, artifacts |
| Why was this dropped? | **Abandonment with a reason**, kept and searchable, never deleted |
| Which model or client made this change? | **Provenance audit log**: append-only, written by a database trigger |

The last row is what makes the pool usable when several agents or models share it.

## Provenance audit log

Every insert, update and delete on the nine mutable tables is recorded by a
PostgreSQL trigger into `intention_audit_log`, with the full row before and after.

- **The actor is not a tool argument.** The server sets `app.actor_model` and
  `app.actor_client` as connection-level PostgreSQL settings from its own environment
  (`ACTOR_MODEL`, `ACTOR_CLIENT`). The trigger reads them with `current_setting()`.
  A model cannot claim to be someone else by passing different arguments.
- **The log is append-only, and the database enforces it.** Guard triggers on the
  log reject `UPDATE`, `DELETE` and `TRUNCATE`, and reject any `INSERT` that does
  not come from the audit trigger itself. This holds even for a role that was
  granted `ALL` on the table, so the guarantee does not depend on getting grants
  right. The boundary is administrative: a superuser or the table owner can drop
  the guard triggers.
- **It covers the journey too**, not only the intention row: milestones, progress,
  next steps, artifacts, insights and blockers are all audited.

Run one server process per agent with its own `ACTOR_MODEL` / `ACTOR_CLIENT`, point
them at the same database, and `get_intention_audit` shows who did what:

```json
{
  "entity_type": "intentions",
  "operation": "UPDATE",
  "actor_model": "claude-opus",
  "actor_client": "claude-code",
  "changed_at": "2026-08-22T12:41:07.513Z",
  "old_data": { "energy": 0.50, "content": "Rotate the staging API keys", "...": "..." },
  "new_data": { "energy": 0.40, "content": "Rotate the staging API keys", "...": "..." }
}
```

## Concepts

**Intention.** A piece of text plus `energy`, a `status` (`active`, `suspended`,
`fulfilled`, `abandoned`), free-form JSON `context` (for example `project`, `type`,
`tags`) and an optional parent.

**Lifecycle.**

```
create ──▶ active ──▶ evolve (new wording and/or energy change, old version kept)
                  ├─▶ fulfill  (with notes)
                  └─▶ abandon  (with a reason)
```

Energy is clamped to the 0–1 range. Nothing is hard-deleted by the tools.

**Journey.** An optional layer on top of an intention. Milestones are added as they
become visible, not planned up front. Progress entries can shift energy and record
what was learned. Blockers have a severity and a resolution. See
[`CLAUDE_JOURNEY_USAGE.md`](./CLAUDE_JOURNEY_USAGE.md) for the tool-by-tool guide.

## Search

`search_intentions` combines two retrievers over active intentions:

1. **Vector search**: cosine similarity on 384-dim embeddings
   (`all-MiniLM-L6-v2`, run locally through `@xenova/transformers`), HNSW index.
2. **Keyword search**: case-insensitive substring match on content and context,
   scored by the share of query keywords found.

Each result gets one score, `0.2 × vector + 0.8 × keyword`, where a retriever that
did not return the row contributes 0. A second signal can therefore only raise a
result, never lower it.

Known limits, stated plainly:

- The embedding model is small and English-centric. Keyword matching is weighted
  heavily on purpose, to keep non-English queries usable. The cost: a weak keyword
  hit outranks a strong vector-only hit.
- The two weights are fixed constants, not tuned on a benchmark. This is a linear
  blend of raw scores, not rank fusion.
- Keyword matching is substring-based: no stemming, no typo tolerance.
- `project_filter` does not filter. It adds a fixed boost to results whose
  `context.project` matches.
- Only `active` intentions are searched.

`find_similar_intentions` uses the same embeddings to surface near-duplicates as
merge candidates.

## Tools

**Intentions**

| Tool | Purpose |
|---|---|
| `create_intention` | Create an intention with content, energy, context, optional parent |
| `get_intentions` | List by status and minimum energy |
| `evolve_intention` | Change wording and/or energy; the previous version is kept |
| `fulfill_intention` | Mark fulfilled, with notes |
| `abandon_intention` | Drop, with a reason |
| `get_intention_audit` | Provenance history for one intention |

**Journey**

| Tool | Purpose |
|---|---|
| `start_journey` | Start a journey with a first milestone |
| `add_milestone` / `reach_milestone` | Add a milestone; mark it reached with reflections |
| `record_progress` | Log an action and its outcome, optionally shifting energy |
| `add_next_step` | Plan a next step with a priority |
| `add_artifact` | Attach something produced along the way |
| `add_insight` | Record something learned |
| `add_blocker` / `resolve_blocker` | Record a blocker; record its resolution |
| `get_journey` / `get_journey_stats` | Full journey; summary statistics |

**Search**

| Tool | Purpose |
|---|---|
| `search_intentions` | Hybrid vector + keyword search |
| `get_high_energy_intentions` | Top intentions by energy, with recent journey activity |
| `find_similar_intentions` | Near-duplicates of a given intention |
| `generate_embeddings` | Backfill embeddings for rows that lack one |

## Setup

Requirements: Node.js 18+, PostgreSQL 14+ with the
[`pgvector`](https://github.com/pgvector/pgvector) extension available.

```bash
npm install

cp .env.example .env        # then fill in your PostgreSQL credentials

createdb intention_pool
npm start
```

On start the server applies `src/database/schema.sql`, which is idempotent: it
creates the `vector` extension, all tables, the audit trigger and the indexes, and
is safe to run again on every start. The first run also downloads the embedding
model (about 80 MB).

To apply the schema yourself instead:

```bash
psql -d intention_pool -f src/database/schema.sql
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PG_HOST`, `PG_PORT`, `PG_DB`, `PG_USER`, `PG_PASSWORD` | `localhost`, `5432`, `intention_pool`, `postgres`, none | Database connection |
| `ACTOR_MODEL` | `unknown` | Model name written to the audit log |
| `ACTOR_CLIENT` | `unknown` | Client name written to the audit log |
| `AUTO_MIGRATE` | unset | Set to `false` to skip applying the schema on start |

`.env` is read from the repository root, wherever the MCP host starts the process
from. Variables already set in the environment take precedence.

### Running with a least-privilege role

Applying the schema needs an owner role (it creates an extension, tables and
triggers). For a shared deployment, apply the schema once as the owner, then run
each agent's server as a separate non-owner role with `AUTO_MIGRATE=false`:

```sql
CREATE ROLE pool_runtime LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pool_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pool_runtime;
REVOKE INSERT, UPDATE, DELETE ON intention_audit_log FROM pool_runtime;
```

That role cannot alter the schema or drop the guard triggers. The last line is
tidiness, not the safeguard: the triggers reject direct writes to the log either
way.

Backups are unaffected: a regular `pg_dump` / `pg_restore` cycle loads data before
it recreates triggers, so the log restores intact. A data-only restore into an
existing schema needs `--disable-triggers`.

### Connecting an MCP client

Claude Desktop (`claude_desktop_config.json`) or Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "intention-pool": {
      "command": "node",
      "args": ["/absolute/path/to/intention-pool/src/index.js"],
      "env": {
        "ACTOR_MODEL": "claude-opus",
        "ACTOR_CLIENT": "claude-code"
      }
    }
  }
}
```

## Tests

```bash
npm test
```

Without a database this runs the unit tests and static guards over the schema.
The end-to-end tests (lifecycle, audit provenance, append-only enforcement under
blanket grants, search)
run when `TEST_PG_DB` points at a throwaway database whose name contains `test`:

```bash
docker run -d --rm --name pool-test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=intention_pool_test -p 127.0.0.1:55432:5432 pgvector/pgvector:pg16

TEST_PG_DB=intention_pool_test TEST_PG_PORT=55432 TEST_PG_PASSWORD=test npm test
```

## Layout

```
src/
  index.js                    MCP server: tool definitions and handlers
  core/
    intention-manager-pg.js   intention lifecycle
    journey-manager.js        milestones, progress, insights, blockers, artifacts
    intention-searcher.js     high-energy and similarity queries
    hybrid-searcher.js        vector + keyword search
  embeddings/
    embedder.js               local sentence-transformer embeddings
  database/
    connection.js             connection pool, actor settings, schema bootstrap
    schema.sql                tables, pgvector, audit trigger, indexes
tests/                        unit, schema and end-to-end tests
```

## License

MIT
