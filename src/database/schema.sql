-- Schema for Intention Pool with Journey support
-- This extends intentions to support continuous development paths

-- Main intentions table (existing structure preserved)
CREATE TABLE IF NOT EXISTS intentions (
    id VARCHAR(50) PRIMARY KEY,
    content TEXT NOT NULL,
    energy DECIMAL(3,2) DEFAULT 0.5 CHECK (energy >= 0 AND energy <= 1),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'fulfilled', 'abandoned')),
    context JSONB,
    parent_id VARCHAR(50) REFERENCES intentions(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Evolution history for intentions
CREATE TABLE IF NOT EXISTS intention_evolution (
    id SERIAL PRIMARY KEY,
    intention_id VARCHAR(50) REFERENCES intentions(id) ON DELETE CASCADE,
    old_content TEXT,
    old_energy DECIMAL(3,2),
    notes TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Children IDs tracking
CREATE TABLE IF NOT EXISTS intention_children (
    parent_id VARCHAR(50) REFERENCES intentions(id) ON DELETE CASCADE,
    child_id VARCHAR(50) REFERENCES intentions(id) ON DELETE CASCADE,
    PRIMARY KEY (parent_id, child_id)
);

-- JOURNEY TABLES START HERE --

-- Journeys - main journey tracking
CREATE TABLE IF NOT EXISTS journeys (
    intention_id VARCHAR(50) PRIMARY KEY REFERENCES intentions(id) ON DELETE CASCADE,
    current_milestone_id VARCHAR(50),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_update_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB
);

-- Milestones - points on the journey
CREATE TABLE IF NOT EXISTS milestones (
    id VARCHAR(50) PRIMARY KEY,
    intention_id VARCHAR(50) REFERENCES intentions(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status VARCHAR(20) DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'reached', 'skipped', 'blocked')),
    reached_at TIMESTAMP,
    reflections TEXT,
    context JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_milestone_per_journey UNIQUE(id, intention_id)
);

-- Milestone connections (graph structure)
CREATE TABLE IF NOT EXISTS milestone_connections (
    from_milestone_id VARCHAR(50) REFERENCES milestones(id) ON DELETE CASCADE,
    to_milestone_id VARCHAR(50) REFERENCES milestones(id) ON DELETE CASCADE,
    connection_type VARCHAR(20) DEFAULT 'next',
    PRIMARY KEY (from_milestone_id, to_milestone_id)
);

-- Progress log - actions taken
CREATE TABLE IF NOT EXISTS progress_log (
    id VARCHAR(50) PRIMARY KEY,
    intention_id VARCHAR(50) REFERENCES intentions(id) ON DELETE CASCADE,
    milestone_id VARCHAR(50) REFERENCES milestones(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    outcome TEXT,
    energy_shift DECIMAL(3,2),
    learned TEXT,
    session_id VARCHAR(100),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Next steps - planned actions
CREATE TABLE IF NOT EXISTS next_steps (
    id VARCHAR(50) PRIMARY KEY,
    intention_id VARCHAR(50) REFERENCES intentions(id) ON DELETE CASCADE,
    milestone_id VARCHAR(50) REFERENCES milestones(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    priority INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),
    planned_for TIMESTAMP,
    completed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step dependencies
CREATE TABLE IF NOT EXISTS step_dependencies (
    step_id VARCHAR(50) REFERENCES next_steps(id) ON DELETE CASCADE,
    depends_on_step_id VARCHAR(50) REFERENCES next_steps(id) ON DELETE CASCADE,
    PRIMARY KEY (step_id, depends_on_step_id)
);

-- Artifacts - things created during journey
CREATE TABLE IF NOT EXISTS artifacts (
    id VARCHAR(50) PRIMARY KEY,
    intention_id VARCHAR(50) REFERENCES intentions(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    location TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insights - discoveries made
CREATE TABLE IF NOT EXISTS insights (
    id VARCHAR(50) PRIMARY KEY,
    intention_id VARCHAR(50) REFERENCES intentions(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    trigger TEXT,
    significance DECIMAL(3,2) DEFAULT 0.5 CHECK (significance >= 0 AND significance <= 1),
    discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insight-milestone relationships
CREATE TABLE IF NOT EXISTS insight_milestones (
    insight_id VARCHAR(50) REFERENCES insights(id) ON DELETE CASCADE,
    milestone_id VARCHAR(50) REFERENCES milestones(id) ON DELETE CASCADE,
    PRIMARY KEY (insight_id, milestone_id)
);

-- Blockers - obstacles encountered
CREATE TABLE IF NOT EXISTS blockers (
    id VARCHAR(50) PRIMARY KEY,
    intention_id VARCHAR(50) REFERENCES intentions(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    severity VARCHAR(20) DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    identified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    resolution TEXT
);

-- Blocker-milestone relationships
CREATE TABLE IF NOT EXISTS blocker_milestones (
    blocker_id VARCHAR(50) REFERENCES blockers(id) ON DELETE CASCADE,
    milestone_id VARCHAR(50) REFERENCES milestones(id) ON DELETE CASCADE,
    PRIMARY KEY (blocker_id, milestone_id)
);

-- INDEXES for performance
CREATE INDEX IF NOT EXISTS idx_intentions_status ON intentions(status);
CREATE INDEX IF NOT EXISTS idx_intentions_energy ON intentions(energy);
CREATE INDEX IF NOT EXISTS idx_intentions_parent ON intentions(parent_id);
CREATE INDEX IF NOT EXISTS idx_milestones_status ON milestones(status);
CREATE INDEX IF NOT EXISTS idx_milestones_intention ON milestones(intention_id);
CREATE INDEX IF NOT EXISTS idx_progress_intention ON progress_log(intention_id);
CREATE INDEX IF NOT EXISTS idx_progress_timestamp ON progress_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_next_steps_intention ON next_steps(intention_id);
CREATE INDEX IF NOT EXISTS idx_next_steps_priority ON next_steps(priority);
CREATE INDEX IF NOT EXISTS idx_artifacts_intention ON artifacts(intention_id);
CREATE INDEX IF NOT EXISTS idx_insights_intention ON insights(intention_id);
CREATE INDEX IF NOT EXISTS idx_blockers_intention ON blockers(intention_id);
CREATE INDEX IF NOT EXISTS idx_blockers_severity ON blockers(severity);

-- Update trigger for intentions
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Update trigger for journeys (uses last_update_at instead of updated_at)
CREATE OR REPLACE FUNCTION update_last_update_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_update_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Drop triggers if exist and recreate
DROP TRIGGER IF EXISTS update_intentions_updated_at ON intentions;
CREATE TRIGGER update_intentions_updated_at BEFORE UPDATE
    ON intentions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_journeys_last_update_at ON journeys;
CREATE TRIGGER update_journeys_last_update_at BEFORE UPDATE
    ON journeys FOR EACH ROW EXECUTE FUNCTION update_last_update_at_column();