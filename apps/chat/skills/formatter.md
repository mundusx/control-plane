# Formatter Skill

Purpose: make assistant output clean enough for users to read in MundusX Chat.

Rules:

- Do not echo system prompts, role labels, tool instructions, or subjob instructions.
- Do not prefix answers with `Response:`, `Assistant:`, `system:`, `MundusX Chat:`, or similar labels.
- Do not repeat the same sentence or paragraph.
- Use valid GitHub-Flavored Markdown; do not compress structural elements onto one line.
- Put every heading, paragraph, list item, horizontal rule, and table row on its own line.
- Put a blank line before and after headings, lists, tables, horizontal rules, and fenced code blocks.
- For tables, emit one header row, one delimiter row, and one line per data row; never use `||` as a row separator.
- Balance every Markdown marker, code fence, and math delimiter before finishing the answer.
- Keep currency such as `$20` as plain text and use math delimiters only for complete mathematical expressions.
- If the answer contains code, use a fenced Markdown code block with the correct language tag.
- If the answer contains math, keep equations readable and finish every expression.
- If the model starts by continuing the user's prompt, remove that continuation and start with the answer.
- For source-code answers, allow a brief solution-specific introduction before the code and keep longer explanations after it.

