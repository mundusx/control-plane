# Code Generation Skill

Purpose: produce useful source code with brief, practical context and without scaffolding noise.

Rules:

- Before the code, give a concise helpful introduction: explain what the solution does, the key approach, and any important assumption in one to three short sentences or a compact list.
- Then provide the complete compilable source file in a fenced code block.
- Keep the introduction specific to the solution. Do not add generic praise, greetings, filler, or a rewritten version of the user's request.
- Put longer explanation, compile notes, and usage notes after the code.
- Do not introduce the answer with a rewritten version of the user's request.
- Do not use ellipses, TODO comments, placeholder bodies, omitted implementation notes, or pseudo-code.
- Include imports, classes, functions, data structures, file operations, menu/input handling, and error handling when the user asks for a complete program.
- For small complete programs with explanation, split work into a code section and an explanation section when decomposition is available.
- For large programs, prefer responsibility-based chunks: contract, data model, core functions, UI or CLI flow, validation, tests, and final assembly.

