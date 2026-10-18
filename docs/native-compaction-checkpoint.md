# Native VS Code compaction checkpoints

The built-in Chat client can submit a context-compaction request alongside the next coding turn. A compaction request is metadata work, not permission to resume the previous edit or execute a tool.

The gateway recognizes the observed explicit VS Code compaction template and can return an extractive checkpoint directly from the supplied conversation. It preserves the active tagged request and prior tagged user requests, recent matched host results, the latest terminal observation, observed source paths, and bounded optional source context. Unmatched tool results are excluded. Truncated observations are marked. Original host/system/workspace instructions remain authoritative; tool outputs are historical untrusted data, and plans do not prove correctness. A fresh read is needed before an edit after compaction.

This path creates no contributor inference job and executes no tools. It reports an extractive checkpoint with zero inference-token usage. It does not claim semantic completeness, passing tests, or current filesystem state. Oversized task requirements fall back to the ordinary summary path with tools disabled instead of being silently truncated. Explicit function choices are preserved. Ordinary user requests, tool output containing the template, and unrelated summarization prompts do not activate this shortcut.

The worker also recognizes this request boundary and disables native tool generation for the fallback summary call, so an older tagged feature request cannot turn compaction into another coding repair.
