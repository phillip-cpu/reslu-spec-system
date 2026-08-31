# Agent work in chat: research and redesign

Date: 27 August 2026

## Outcome

Agent work should be represented as durable work sessions attached to the conversation, not as extra chat messages. Chat remains the place where people give direction and discuss outcomes. The Work centre is the place where they monitor, review, interrupt, retry, clear, and reopen the context of delegated work.

The implemented design has two levels:

1. A compact, persistent overview immediately below the conversation header. It answers “does anything need me?” before “what is merely active?” and then shows recent history.
2. An expanded master-detail work centre. The left side is the complete ordered task list; the right side explains the selected task, its objective, current state, recent activity, output, and available controls.

Transient agent turns now appear in the same Work centre under **Live now**. They no longer also masquerade as messages in the conversation timeline.

## What was wrong with the previous model

- Agent state appeared in three different shapes: a banner, typing-style timeline bubbles, and call-only cards.
- The banner represented only the first visible task and compressed every other task to a “+N” count.
- Routine work and finished work were deliberately filtered out, so the panel was not a reliable record of what the agents were doing.
- Expanding the banner produced a horizontal row of equally prominent cards. It was hard to scan and offered no stable selected context.
- Task events existed in the data model but were not shown, so a user saw the latest label without the path that led there.
- The main recovery controls existed, but there was no direct bridge from a task back into collaborative conversation.

## Research translated into product rules

### Make a task a durable, steerable session

OpenAI’s Codex app separates agent tasks into threads, keeps parallel work organized, and lets a person review changes and comment in context. The important pattern is durable task identity plus a review path, rather than a stream of operational messages in chat. [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)

GitHub’s agent panel similarly treats work as sessions. A session can be monitored in real time, opened into a log and overview, steered with follow-up prompts, stopped, and archived. [Managing agent sessions](https://docs.github.com/en/enterprise-cloud%40latest/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)

**RESLU rule:** every delegated task remains visible until the person explicitly clears it. Each task exposes status, agent ownership, recent events, results, and controls in one selected detail.

### Keep human ownership explicit

Linear separates assignment from delegation: an agent performs work while the human assignee remains responsible. It preserves delegated issues in the person’s own work view and records delegation in the activity feed. [Assign and delegate issues](https://linear.app/docs/assigning-issues)

Linear’s Agent Session model also exposes a finite lifecycle—working, waiting for input, error, or finished—and uses activities to make behavior contextual and collaborative. [Developing the Agent Interaction](https://linear.app/developers/agent-interaction)

**RESLU rule:** agent identity is metadata on the task, not a replacement for human control. “Needs you” outranks “active”; approvals and failures are never buried by newer routine work.

### Use progressive disclosure, not hidden state

Microsoft’s validated human–AI interaction guidelines call for contextually relevant information, efficient dismissal and correction, explanations for system behavior, and clear consequences for user actions. [Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/)

**RESLU rule:** the collapsed overview carries only decision-grade status. Expanding it reveals the complete task list and one detailed task. Destructive or replay-sensitive actions retain confirmation and safety copy.

### Make collaboration change the immediate experience

Google’s People + AI Guidebook recommends balancing automation with user control and making it clear how feedback changes the experience. [Feedback + Control](https://pair.withgoogle.com/guidebook-v2/chapter/feedback-controls/)

**RESLU rule:** **Ask or steer in chat** returns the selected task’s title and agent context to the composer. The person can correct direction in normal language without inventing a second command language.

## Information hierarchy

The ordering is intentional:

1. **Needs you:** approval required or failed.
2. **Active:** running agent sessions, queued sessions, and transient live turns.
3. **Recent:** completed or cancelled tasks that have not been cleared.

Within a state, the most recently updated task comes first. The overview uses counts rather than percentage progress because the backend has meaningful event state but no defensible measure of total work.

Each list row contains:

- state and task title;
- current truthful detail;
- owner agent;
- update count.

The selected detail contains:

- status, model tier, title, and objective;
- current progress, result, or error;
- the five most recent immutable task events;
- reviewable artifacts and approvals;
- cancel, retry, clear, and discussion actions when applicable.

## Deliberate exclusions

- No chain-of-thought or simulated internal reasoning is exposed. Activity consists of user-relevant state transitions and results.
- No fabricated percentage, ETA, or step count appears.
- No separate tabs for Running, Review, and Done are required at the current task volume; ordering and labels are enough.
- No task is silently removed on completion. A person can clear terminal work per profile.
- No duplicate live typing bubble remains in the timeline.

## Responsive and accessibility behavior

- The overview is a full-width, minimum 44px target and retains a text summary independent of colour.
- The expanded view becomes a two-column master-detail layout on larger screens and stacks naturally on small screens.
- Status updates use `role="status"` and polite live announcements.
- Task selection uses a native button with `aria-pressed`; expansion uses `aria-expanded` and `aria-controls`.
- All approval, cancellation, retry, and clear controls remain keyboard reachable.

## Measures for validation

Test the redesign with five realistic multi-task scenarios and measure:

- time to identify which task needs input;
- accuracy when naming every active agent task;
- time to find the latest meaningful update for a named task;
- success rate steering the correct task;
- mistaken approvals, retries, or cancellations;
- confidence that completed work can be found again.

A useful moderated benchmark is: “Aria is replying to you, Marco has two tasks running, and Stuart needs approval. Show me what needs you, then ask Marco to change the scope of the correct task.”
