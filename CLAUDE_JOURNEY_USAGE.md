# Journey System — Usage

The journey layer turns an intention into a living path: milestones, recorded
progress, insights, blockers and artifacts. It is **not** a TODO list — milestones
appear as you reach them, not as an upfront plan.

## Commands

### Start a journey
```
start_journey(intention_id, milestone_title, milestone_description)
```
Creates the first milestone and starts the journey for an intention.

### Record progress
```
record_progress(intention_id, action, outcome, options)
```
Logs an action on the path. `options`: `energy_shift`, `learned`, `milestone_id`.

**About `milestone_id`:** if you omit it, the progress is recorded against the
intention in general. If you pass it, use a **real** id from `get_journey` — never
invent one.

### Reach a milestone
```
reach_milestone(intention_id, milestone_id, reflections)
```
Marks a milestone as reached, with a short reflection.

**Important:** `milestone_id` must be a real id from `get_journey`. First fetch the
journey, find the milestone, then use its id.

### Add a next step
```
add_next_step(intention_id, description, priority, milestone_id)
```

### Add an insight
```
add_insight(intention_id, content, trigger, significance)
```

### Get the journey
```
get_journey(intention_id)
```
Returns the full picture: milestones, progress, insights, artifacts.

## Recommended workflow

1. **Orient:** `get_journey(intention_id)` — see where you are.
2. **Log actions:** `record_progress` without `milestone_id` for general actions.
3. **Tie to milestones:** if an action belongs to a specific milestone, pass its id
   from `get_journey`.
4. **Reach milestones:** fetch the journey, find the `milestone_id`, then
   `reach_milestone`.
5. **Capture insights:** record what you learned with `add_insight`.

## Example

```javascript
// Start a journey
start_journey("int_123", "Research", "Scope the problem space")

// Record progress
record_progress("int_123",
  "Reviewed 5 candidate approaches",
  "Two look promising",
  { energy_shift: 0.1, learned: "Approach A has the simplest integration" })

// Capture an insight
add_insight("int_123",
  "A small local model is enough for this step",
  "Benchmarking",
  0.8)

// Plan the next step
add_next_step("int_123", "Prototype approach A", 8)
```
