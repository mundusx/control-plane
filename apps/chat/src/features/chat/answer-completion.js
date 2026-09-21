import { detectChatQualityFlags, detectDegenerateRepetitionQualityFlags } from "../../chat-quality.js";

export function answerCompletionGaps(content, prompt) {
  return [
    ...detectChatQualityFlags(content, content, content, prompt),
    ...detectDegenerateRepetitionQualityFlags(content),
  ].filter(flag => ["invalid_math_output", "degenerate_repetition"].includes(flag.code))
    .map(flag => flag.code === "invalid_math_output"
      ? "Finish the pending mathematical expression, close its math delimiters, and give the requested result and working. Do not restart the answer or introduce a different problem."
      : "Finish the requested answer without repeating the previous text loop.");
}
