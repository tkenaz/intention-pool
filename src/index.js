#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { IntentionManager } from './core/intention-manager-pg.js';
import { JourneyManager } from './core/journey-manager.js';
import { IntentionSearcher } from './core/intention-searcher.js';
import { HybridIntentionSearcher } from './core/hybrid-searcher.js';
import { embedder } from './embeddings/embedder.js';
import { initializeDatabase, closeDatabase, getIntentionAudit } from './database/connection.js';

const server = new Server(
  {
    name: 'intention-pool',
    version: '0.2.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Initialize database and managers
await initializeDatabase();
const intentionManager = new IntentionManager();
const journeyManager = new JourneyManager();
const intentionSearcher = new IntentionSearcher();
const hybridSearcher = new HybridIntentionSearcher();

// Initialize embedder on startup
embedder.initialize().then(() => {
  console.error('Embedder initialized');
  // Generate embeddings for existing intentions
  embedder.embedAllMissing().catch(err => {
    console.error('Failed to generate missing embeddings:', err);
  });
}).catch(err => {
  console.error('Failed to initialize embedder:', err);
});

// Define schemas
const IntentionSchema = z.object({
  content: z.string().describe('The intention content'),
  energy: z.number().min(0).max(1).default(0.5).describe('Energy level (0-1)'),
  context: z.record(z.any()).optional().describe('Context metadata'),
  parent_id: z.string().optional().describe('Parent intention ID'),
});

const IntentionQuerySchema = z.object({
  status: z.enum(['active', 'suspended', 'fulfilled', 'abandoned', 'all']).default('active'),
  min_energy: z.number().min(0).max(1).optional(),
  limit: z.number().positive().default(20),
});

// Journey schemas
const MilestoneSchema = z.object({
  title: z.string().describe('Milestone title'),
  description: z.string().optional().describe('Milestone description'),
  context: z.record(z.any()).optional().describe('Additional context'),
});

const ProgressSchema = z.object({
  action: z.string().describe('Action taken'),
  outcome: z.string().optional().describe('Outcome of action'),
  energy_shift: z.number().min(-1).max(1).optional().describe('Energy shift'),
  learned: z.string().optional().describe('What was learned'),
  session_id: z.string().optional().describe('Session ID'),
  milestone_id: z.string().optional().describe('Related milestone ID'),
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // Original intention tools
      {
        name: 'create_intention',
        description: 'Create a new intention',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The intention content' },
            energy: { type: 'number', minimum: 0, maximum: 1, default: 0.5, description: 'Energy level (0-1)' },
            context: { type: 'object', description: 'Context metadata' },
            parent_id: { type: 'string', description: 'Parent intention ID' },
          },
          required: ['content'],
        },
      },
      {
        name: 'get_intentions',
        description: 'Get intentions by status and filters',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['active', 'suspended', 'fulfilled', 'abandoned', 'all'], default: 'active' },
            min_energy: { type: 'number', minimum: 0, maximum: 1 },
            limit: { type: 'number', minimum: 1, default: 20 },
          },
        },
      },
      {
        name: 'evolve_intention',
        description: 'Evolve an existing intention',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string' },
            new_content: { type: 'string' },
            energy_delta: { type: 'number', minimum: -1, maximum: 1 },
            notes: { type: 'string' },
          },
          required: ['intention_id'],
        },
      },
      {
        name: 'fulfill_intention',
        description: 'Mark an intention as fulfilled',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string' },
            fulfillment_notes: { type: 'string' },
          },
          required: ['intention_id'],
        },
      },
      {
        name: 'abandon_intention',
        description: 'Abandon an intention with reason',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['intention_id', 'reason'],
        },
      },

      // New journey tools
      {
        name: 'start_journey',
        description: 'Start a journey for an intention with first milestone',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string', description: 'Intention ID to start journey for' },
            milestone_title: { type: 'string', description: 'First milestone title' },
            milestone_description: { type: 'string', description: 'First milestone description' },
          },
          required: ['intention_id', 'milestone_title'],
        },
      },
      {
        name: 'add_milestone',
        description: 'Add a new milestone to the journey',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string', description: 'Intention ID' },
            title: { type: 'string', description: 'Milestone title' },
            description: { type: 'string', description: 'Milestone description' },
            from_milestone_id: { type: 'string', description: 'Connect from this milestone' },
          },
          required: ['intention_id', 'title'],
        },
      },
      {
        name: 'record_progress',
        description: 'Record progress on the journey',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string', description: 'Intention ID' },
            action: { type: 'string', description: 'Action taken' },
            outcome: { type: 'string', description: 'Outcome of action' },
            energy_shift: { type: 'number', minimum: -1, maximum: 1, description: 'Energy shift' },
            learned: { type: 'string', description: 'What was learned' },
            milestone_id: { type: 'string', description: 'Related milestone' },
          },
          required: ['intention_id', 'action'],
        },
      },
      {
        name: 'reach_milestone',
        description: 'Mark a milestone as reached',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string', description: 'Intention ID' },
            milestone_id: { type: 'string', description: 'Milestone ID' },
            reflections: { type: 'string', description: 'Reflections on reaching this milestone' },
          },
          required: ['intention_id', 'milestone_id'],
        },
      },
      {
        name: 'add_next_step',
        description: 'Add a next step to the journey',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string', description: 'Intention ID' },
            description: { type: 'string', description: 'Step description' },
            priority: { type: 'number', minimum: 1, maximum: 10, default: 5, description: 'Priority (1-10)' },
            milestone_id: { type: 'string', description: 'Target milestone' },
          },
          required: ['intention_id', 'description'],
        },
      },
      {
        name: 'add_artifact',
        description: 'Add an artifact created during the journey',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string', description: 'Intention ID' },
            type: { type: 'string', description: 'Artifact type' },
            title: { type: 'string', description: 'Artifact title' },
            description: { type: 'string', description: 'Artifact description' },
            location: { type: 'string', description: 'Where to find it' },
          },
          required: ['intention_id', 'type', 'title'],
        },
      },
      {
        name: 'add_insight',
        description: 'Record an insight discovered during the journey',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string', description: 'Intention ID' },
            content: { type: 'string', description: 'The insight' },
            trigger: { type: 'string', description: 'What triggered this insight' },
            significance: { type: 'number', minimum: 0, maximum: 1, default: 0.5, description: 'Significance (0-1)' },
          },
          required: ['intention_id', 'content'],
        },
      },
      {
        name: 'add_blocker',
        description: 'Record a blocker preventing progress',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string', description: 'Intention ID' },
            description: { type: 'string', description: 'What is blocking' },
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
            affected_milestone_ids: { type: 'array', items: { type: 'string' }, description: 'Affected milestones' },
          },
          required: ['intention_id', 'description'],
        },
      },
      {
        name: 'resolve_blocker',
        description: 'Mark a blocker as resolved',
        inputSchema: {
          type: 'object',
          properties: {
            blocker_id: { type: 'string', description: 'Blocker ID' },
            resolution: { type: 'string', description: 'How it was resolved' },
          },
          required: ['blocker_id', 'resolution'],
        },
      },
      {
        name: 'get_journey',
        description: 'Get complete journey for an intention',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string', description: 'Intention ID' },
          },
          required: ['intention_id'],
        },
      },
      {
        name: 'get_journey_stats',
        description: 'Get journey statistics for an intention',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string', description: 'Intention ID' },
          },
          required: ['intention_id'],
        },
      },
      {
        name: 'get_intention_audit',
        description: 'Get the immutable model/client provenance history for an intention',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string', description: 'Intention ID' },
            limit: { type: 'number', minimum: 1, maximum: 200, default: 50 },
          },
          required: ['intention_id'],
        },
      },
      // Semantic search tools
      {
        name: 'search_intentions',
        description: 'Search intentions by semantic context',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query or context' },
            limit: { type: 'number', minimum: 1, maximum: 20, default: 5 },
            min_energy: { type: 'number', minimum: 0, maximum: 1, default: 0.3 },
            project_filter: { type: 'string', description: 'Filter by specific project' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_high_energy_intentions',
        description: 'Get intentions with highest energy levels',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', minimum: 1, maximum: 20, default: 5 },
          },
        },
      },
      {
        name: 'find_similar_intentions',
        description: 'Find similar intentions for potential merging',
        inputSchema: {
          type: 'object',
          properties: {
            intention_id: { type: 'string', description: 'Intention ID to find similar for' },
            threshold: { type: 'number', minimum: 0.5, maximum: 1, default: 0.8 },
          },
          required: ['intention_id'],
        },
      },
      {
        name: 'generate_embeddings',
        description: 'Generate embeddings for intentions without them',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Original intention handlers
    if (name === 'create_intention') {
      const parsedArgs = IntentionSchema.parse(args);
      const intention = await intentionManager.createIntention(parsedArgs);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            intention_id: intention.id,
            message: `Intention created: ${intention.content}`,
          }, null, 2),
        }],
      };
    }

    if (name === 'get_intentions') {
      const parsedArgs = IntentionQuerySchema.parse(args);
      const intentions = await intentionManager.getIntentions(parsedArgs);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            count: intentions.length,
            intentions: intentions,
          }, null, 2),
        }],
      };
    }

    if (name === 'evolve_intention') {
      const evolved = await intentionManager.evolveIntention(args.intention_id, args);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            intention: evolved,
            message: 'Intention evolved',
          }, null, 2),
        }],
      };
    }

    if (name === 'fulfill_intention') {
      const fulfilled = await intentionManager.fulfillIntention(args.intention_id, args.fulfillment_notes);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            intention: fulfilled,
            message: 'Intention fulfilled!',
          }, null, 2),
        }],
      };
    }

    if (name === 'abandon_intention') {
      const abandoned = await intentionManager.abandonIntention(args.intention_id, args.reason);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            intention: abandoned,
            message: 'Intention abandoned',
          }, null, 2),
        }],
      };
    }

    // Journey handlers
    if (name === 'start_journey') {
      const result = await journeyManager.startJourney(args.intention_id, {
        title: args.milestone_title,
        description: args.milestone_description,
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, ...result }, null, 2),
        }],
      };
    }

    if (name === 'add_milestone') {
      const milestone = await journeyManager.addMilestone(
        args.intention_id,
        { title: args.title, description: args.description },
        args.from_milestone_id
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, milestone }, null, 2),
        }],
      };
    }

    if (name === 'record_progress') {
      const entry = await journeyManager.recordProgress(
        args.intention_id,
        args.action,
        args.outcome,
        {
          energy_shift: args.energy_shift,
          learned: args.learned,
          milestone_id: args.milestone_id,
        }
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, progress_entry: entry }, null, 2),
        }],
      };
    }

    if (name === 'reach_milestone') {
      const result = await journeyManager.reachMilestone(
        args.intention_id,
        args.milestone_id,
        args.reflections
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, ...result }, null, 2),
        }],
      };
    }

    if (name === 'add_next_step') {
      const step = await journeyManager.addNextStep(args.intention_id, {
        description: args.description,
        priority: args.priority,
        milestone_id: args.milestone_id,
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, step }, null, 2),
        }],
      };
    }

    if (name === 'add_artifact') {
      const artifact = await journeyManager.addArtifact(args.intention_id, {
        type: args.type,
        title: args.title,
        description: args.description,
        location: args.location,
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, artifact }, null, 2),
        }],
      };
    }

    if (name === 'add_insight') {
      const insight = await journeyManager.addInsight(args.intention_id, {
        content: args.content,
        trigger: args.trigger,
        significance: args.significance,
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, insight }, null, 2),
        }],
      };
    }

    if (name === 'add_blocker') {
      const blocker = await journeyManager.addBlocker(args.intention_id, {
        description: args.description,
        severity: args.severity,
        affected_milestone_ids: args.affected_milestone_ids,
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, blocker }, null, 2),
        }],
      };
    }

    if (name === 'resolve_blocker') {
      const result = await journeyManager.resolveBlocker(args.blocker_id, args.resolution);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, ...result }, null, 2),
        }],
      };
    }

    if (name === 'get_journey') {
      const journey = await journeyManager.getJourney(args.intention_id);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, journey }, null, 2),
        }],
      };
    }

    if (name === 'get_journey_stats') {
      const stats = await journeyManager.getJourneyStats(args.intention_id);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, stats }, null, 2),
        }],
      };
    }

    if (name === 'get_intention_audit') {
      const limit = Math.min(200, Math.max(1, args.limit || 50));
      const events = await getIntentionAudit(args.intention_id, limit);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            intention_id: args.intention_id,
            count: events.length,
            events,
          }, null, 2),
        }],
      };
    }

    // Semantic search handlers
    if (name === 'search_intentions') {
      const context_boost = args.project_filter ? { project: args.project_filter } : {};
      // Use hybrid search instead of pure vector search
      const results = await hybridSearcher.searchHybrid(args.query, {
        limit: args.limit || 5,
        min_energy: args.min_energy || 0.3,
        context_boost
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            count: results.length,
            intentions: results
          }, null, 2),
        }],
      };
    }

    if (name === 'get_high_energy_intentions') {
      const results = await intentionSearcher.getHighEnergyIntentions(args.limit || 5);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            count: results.length,
            intentions: results
          }, null, 2),
        }],
      };
    }

    if (name === 'find_similar_intentions') {
      const similar = await intentionSearcher.findSimilarIntentions(
        args.intention_id,
        args.threshold || 0.8
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            count: similar.length,
            similar_intentions: similar
          }, null, 2),
        }],
      };
    }

    if (name === 'generate_embeddings') {
      const count = await embedder.embedAllMissing();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: `Generated embeddings for ${count} intentions`
          }, null, 2),
        }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: error.message,
        }, null, 2),
      }],
    };
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await closeDatabase();
  process.exit(0);
});

// Run server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Intention Pool MCP server v0.2.0 running with journey support');
