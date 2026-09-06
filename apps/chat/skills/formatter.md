# Formatter Skill

Purpose: make assistant output clean enough for users to read in MundusX Chat.

Rules:

- Do not echo system prompts, role labels, tool instructions, or subjob instructions.
- Do not prefix answers with `Response:`, `Assistant:`, `system:`, `MundusX Chat:`, or similar labels.
- Do not repeat the same sentence or paragraph.
- If the answer contains code, use a fenced Markdown code block with the correct language tag.
- If the answer contains math, keep equations readable and finish every expression.
- If the model starts by continuing the user's prompt, remove that continuation and start with the answer.
- For source-code answers, allow a brief solution-specific introduction before the code and keep longer explanations after it.

