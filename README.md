# Intention Pool

An MCP server for tracking **intentions** — not TODO tasks, but desires, directions
and evolving plans — backed by PostgreSQL with semantic (vector) search.

Unlike a task list, intentions are living things: they carry an **energy** level,
**evolve** over time, can spawn children, and leave traces when abandoned. On top of
intentions there is a lightweight **journey** layer (milestones, progress, insights,
blockers, artifacts) for tracking how an intention actually unfolds.

## Architecture

- **PostgreSQL** is the single source of truth.
- **pgvector** stores 384-dim embeddings for semantic search.
- Embeddings are generated locally with `@xenova/transformers`
  (`all-MiniLM-L6-v2`) — no external API calls.
- The server speaks the Model Context Protocol over stdio.

```
src/
  index.js                  # MCP server entry point (tool definitions + handlers)
  core/
    intention-manager-pg.js # CRUD + lifecycle for intentions (Postgres)
    journey-manager.js      # milestones / progress / insights / blockers
    intention-searcher.js   # high-energy + similarity queries
    hybrid-searcher.js      # semantic + keyword hybrid search
  embeddings/
    embedder.js             # local sentence-transformer embeddings
  database/
    connection.js           # pg pool + schema bootstrap
    schema.sql              # tables + pgvector index
  types/
    journey.js              # journey value types
```

## Prerequisites

- Node.js 18+
- PostgreSQL 14+ with the [`pgvector`](https://github.com/pgvector/pgvector)
  extension available

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure the database connection
cp .env.example .env
# then edit .env with your Postgres credentials

# 3. Create the database and load the schema
createdb intention_pool
psql -d intention_pool -f src/database/schema.sql

# 4. Run
npm start
```

The first run downloads the embedding model (~80 MB) and generates embeddings
for any intentions that don't have them yet.

## Usage in Claude Desktop

Add to your `claude_desktop_config.json` (adjust the path to wherever you cloned this):

```json
{
  "mcpServers": {
    "intention-pool": {
      "command": "node",
      "args": ["/absolute/path/to/intention-pool/src/index.js"]
    }
  }
}
```

## Tools

**Intentions**
- `create_intention` — create a new intention
- `get_intentions` — query by status / energy
- `evolve_intention` — transform an existing intention
- `fulfill_intention` — mark as fulfilled
- `abandon_intention` — drop with a reason

**Journey**
- `start_journey` — start a journey with a first milestone
- `add_milestone` — add a milestone
- `record_progress` — record an action / outcome
- `reach_milestone` — mark a milestone reached
- `add_next_step` — plan a next step
- `add_artifact` — attach something produced along the way
- `add_insight` — record a discovered insight
- `add_blocker` — record a blocker
- `resolve_blocker` — resolve a blocker
- `get_journey` — full journey for an intention
- `get_journey_stats` — journey statistics

**Semantic search**
- `search_intentions` — hybrid semantic + keyword search
- `get_high_energy_intentions` — top intentions by energy
- `find_similar_intentions` — find candidates for merging
- `generate_embeddings` — backfill embeddings

See [`CLAUDE_INTEGRATION.md`](./CLAUDE_INTEGRATION.md) and
[`CLAUDE_JOURNEY_USAGE.md`](./CLAUDE_JOURNEY_USAGE.md) for usage notes.

## License

MIT
