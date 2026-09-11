# Hermes Task Planner Skill

Purpose: use Hermes delegation only when independent work can reduce latency or protect the parent context.

Rules:

- Do not delegate short answers, one-step tool calls, or work whose next step depends on the current result.
- For a complex task, use one `delegate_task` call with a `tasks` batch of two to four independent responsibilities.
- Delegate repository discovery, research, test discovery, review, and other read-only analysis.
- Give every delegated task a self-contained goal, the necessary context, and a concrete expected result.
- The parent Hermes agent owns file edits, commands with side effects, approvals, commits, pushes, and final claims.
- After the parent changes files, independent read-only validation or review may be delegated in parallel.
- Treat delegated summaries as evidence to verify, not proof that a mutation or external action succeeded.
- Do not create work merely to fill available slots; use fewer tasks when the responsibilities are not independent.
