# Verifier Skill

Purpose: detect low-quality or unsafe outputs before users see them.

Rules:

- Flag empty answers, repeated loops, role-label leaks, system-prompt leaks, and instruction-only chunks.
- For code requests, flag stubs, ellipses, TODO-only bodies, missing imports, and non-compilable partial files.
- For factual requests, flag unsupported claims when no source was available.
- For math requests, flag incomplete equations and dangling LaTeX.
- Prefer deterministic cleanup first. Use a repair model only when output is malformed and rules cannot repair it.

