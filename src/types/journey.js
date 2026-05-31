// Journey types for intention continuity
// This is not a TODO list - it's a living path of development

export const JourneyTypes = {
  MILESTONE_STATUS: {
    PLANNED: 'planned',
    IN_PROGRESS: 'in_progress',
    REACHED: 'reached',
    SKIPPED: 'skipped',
    BLOCKED: 'blocked'
  },

  BLOCKER_SEVERITY: {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical'
  }
};

/**
 * Milestone on the journey - organic points of achievement
 * @typedef {Object} Milestone
 * @property {string} id - Unique milestone ID
 * @property {string} title - Milestone title
 * @property {string} [description] - Optional description
 * @property {'planned'|'in_progress'|'reached'|'skipped'|'blocked'} status
 * @property {Date} [reached_at] - When milestone was reached
 * @property {string} [reflections] - What was learned/understood
 * @property {string[]} [next_milestone_ids] - Next possible milestones (graph structure)
 * @property {Object} [context] - Additional context data
 */

/**
 * Progress entry - record of action taken
 * @typedef {Object} ProgressEntry
 * @property {string} id - Unique entry ID
 * @property {Date} timestamp - When action was taken
 * @property {string} action - What was done
 * @property {string} [outcome] - What happened as result
 * @property {number} [energy_shift] - How it affected intention energy
 * @property {string} [learned] - Insights gained
 * @property {string} [session_id] - Link to specific session
 * @property {string} [milestone_id] - Related milestone if any
 */

/**
 * Artifact created during journey
 * @typedef {Object} Artifact
 * @property {string} id - Unique artifact ID
 * @property {string} type - Type of artifact (code, document, insight, etc)
 * @property {string} title - Artifact title
 * @property {string} [description] - What this artifact represents
 * @property {string} [location] - Where to find it (URL, file path, etc)
 * @property {Date} created_at - When created
 * @property {Object} [metadata] - Additional metadata
 */

/**
 * Blocker preventing progress
 * @typedef {Object} Blocker
 * @property {string} id - Unique blocker ID
 * @property {string} description - What is blocking progress
 * @property {'low'|'medium'|'high'|'critical'} severity
 * @property {Date} identified_at - When blocker was identified
 * @property {Date} [resolved_at] - When blocker was resolved
 * @property {string} [resolution] - How it was resolved
 * @property {string[]} [affected_milestone_ids] - Which milestones are blocked
 */

/**
 * Insight discovered during journey
 * @typedef {Object} Insight
 * @property {string} id - Unique insight ID
 * @property {string} content - The insight itself
 * @property {Date} discovered_at - When discovered
 * @property {string} [trigger] - What triggered this insight
 * @property {number} [significance] - How significant (0-1)
 * @property {string[]} [related_milestone_ids] - Related milestones
 */

/**
 * Next planned step
 * @typedef {Object} NextStep
 * @property {string} id - Unique step ID
 * @property {string} description - What needs to be done
 * @property {number} [priority] - Priority level (1-10)
 * @property {string} [milestone_id] - Target milestone
 * @property {Date} [planned_for] - When planning to do this
 * @property {string[]} [dependencies] - What needs to happen first
 */

/**
 * Complete journey structure
 * @typedef {Object} Journey
 * @property {string} intention_id - Parent intention ID
 * @property {Milestone[]} milestones - All milestones on the path
 * @property {string} [current_milestone_id] - Current position
 * @property {ProgressEntry[]} progress_log - History of actions
 * @property {NextStep[]} next_steps - Planned next actions
 * @property {Artifact[]} artifacts - Created artifacts
 * @property {Insight[]} insights - Discoveries made
 * @property {Blocker[]} blockers - Current blockers
 * @property {Date} started_at - Journey start time
 * @property {Date} last_update_at - Last activity time
 * @property {Object} [metadata] - Additional journey metadata
 */

export function createMilestone(data) {
  return {
    id: `milestone_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    status: JourneyTypes.MILESTONE_STATUS.PLANNED,
    next_milestone_ids: [],
    ...data
  };
}

export function createProgressEntry(data) {
  return {
    id: `progress_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date(),
    ...data
  };
}

export function createArtifact(data) {
  return {
    id: `artifact_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    created_at: new Date(),
    ...data
  };
}

export function createBlocker(data) {
  return {
    id: `blocker_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    identified_at: new Date(),
    severity: JourneyTypes.BLOCKER_SEVERITY.MEDIUM,
    affected_milestone_ids: [],
    ...data
  };
}

export function createInsight(data) {
  return {
    id: `insight_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    discovered_at: new Date(),
    significance: 0.5,
    related_milestone_ids: [],
    ...data
  };
}

export function createNextStep(data) {
  return {
    id: `step_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    priority: 5,
    dependencies: [],
    ...data
  };
}

export function createJourney(intention_id, first_milestone) {
  return {
    intention_id,
    milestones: [createMilestone(first_milestone)],
    current_milestone_id: null,
    progress_log: [],
    next_steps: [],
    artifacts: [],
    insights: [],
    blockers: [],
    started_at: new Date(),
    last_update_at: new Date(),
    metadata: {}
  };
}