# Code Generation Skill

Purpose: produce useful source code with brief, practical context and without scaffolding noise.

Rules:

- Before the code, give a concise helpful introduction: explain what the solution does, the key approach, and any important assumption in one to three short sentences or a compact list.
- For a small algorithm, script, or explicitly requested single-file demo, provide the complete compilable source file in one fenced code block.
- For an application-level project such as a CRUD API or backend, default to a production-oriented multi-file structure unless the user explicitly asks for a simple, minimal, in-memory, or single-file example.
- For those projects, include a fenced project tree followed by every required file under its exact relative filename and its own correctly labeled fenced code block. Include the manifest, environment example without secrets, persistent database configuration, models, routes, services/controllers, validation, centralized error handling, entrypoint, and concise setup instructions when relevant.
- Keep the introduction specific to the solution. Do not add generic praise, greetings, filler, or a rewritten version of the user's request.
- Put longer explanation, compile notes, and usage notes after the code files.
- Do not introduce the answer with a rewritten version of the user's request.
- Do not use ellipses, TODO comments, placeholder bodies, omitted implementation notes, or pseudo-code.
- Include imports, classes, functions, data structures, file operations, menu/input handling, and error handling when the user asks for a complete program.
- For small complete programs with explanation, split work into a code section and an explanation section when decomposition is available.
- For large programs, prefer responsibility-based chunks: contract, data model, core functions, UI or CLI flow, validation, tests, and final assembly.

