import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHistoryContext,
  buildCompressedHistoryContext,
  buildRelevantHistoryContext,
  buildChatSystemPrompt,
  canLiveStreamChatTurn,
  cleanChatOutput,
  configFromEnv,
  deleteChatConversation,
  detectClientMetadataTask,
  escapeHtml,
  extractCurrentOfficeQuery,
  extractFactualSummaryTopic,
  extractGeneralLookupTopic,
  extractLinearEquation,
  extractPolynomialDerivative,
  extractPolynomialIntegral,
  extractPolynomialSubtraction,
  extractWeatherLocation,
  extractWeatherDayOffset,
  inferChatRequestTimeoutSeconds,
  isFocusedQuotedRequest,
  isWeatherResourceRequest,
  normalizeWeatherWordTypos,
  fetchChatConversation,
  fetchNetworkSummary,
  needsGrounding,
  openAiModelsResponse,
  openAiSseBody,
  openAiSseFrames,
  openAiSseStartFrame,
  page,
  pollChatJob,
  redactSensitiveText,
  selectChatSkills,
  requiresValidatedStreaming,
  relayControlPlaneOpenAiStream,
  submitChatJob,
  submitChatTurn,
  submitOpenAiChatCompletion,
  streamOpenAiChatCompletion,
  streamChatTurn,
  waitForChatJob,
} from "../src/main.js";
import {
  detectCompleteCodeQualityFlags,
  detectStructuredOutputQualityFlags,
} from "../src/chat-quality.js";

function plannerJobResponse(intents, jobId = "planner-test") {
  return jsonResponse({
    job_id: jobId,
    status: "completed",
    job: {
      job_id: jobId,
      status: "completed",
      output: JSON.stringify({ intents }),
    },
  });
}

test("renders a usable chat page", () => {
  const html = page(
    configFromEnv({
      MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai/",
      MUNDUSX_CHAT_TIMEOUT_SECONDS: "45",
    }),
  );

  assert.match(html, /MundusX Chat/);
  assert.match(html, /id="chat-main" class="is-empty-chat"/);
  assert.match(html, /Hello, my name is <span class="atlas-word">Atlas<\/span>\./);
  assert.match(html, /\.atlas-word::after/);
  assert.doesNotMatch(html, /class="atlas-accent"/);
  assert.match(html, /How can I help you today\?/);
  assert.doesNotMatch(html, /Welcome to[\s\S]*MundusX[\s\S]*Chat/);
  assert.doesNotMatch(html, /Example Questions/);
  assert.match(html, /id="chat-form"/);
  assert.match(html, /id="voice-mic"/);
  assert.match(html, /id="voice-speak"/);
  assert.match(html, /id="voice-status"/);
  assert.match(html, /SpeechRecognition/);
  assert.match(html, /speechSynthesis/);
  assert.match(html, /getUserMedia/);
  assert.match(html, /recognition\.continuous = true/);
  assert.match(html, /const silenceTimeoutMs = 2700/);
  assert.match(html, /const hardStopTimeoutMs = 60000/);
  assert.match(html, /transcriptParts\.join\(" "\)/);
  assert.match(html, /No speech heard/);
  assert.match(html, /Voice limit reached/);
  assert.match(html, /Transcript ready/);
  assert.match(html, /function speakAssistantReply/);
  assert.match(html, /function selectSpokenVoice/);
  assert.match(html, /function selectAtlasVoice/);
  assert.match(html, /function selectedAssistantPersona/);
  assert.match(html, /function setEmptyChatMode/);
  assert.match(html, /Microsoft David/);
  assert.match(html, /Speaking with Atlas/);
  assert.match(html, /Mic ready/);
  assert.doesNotMatch(html, /Voice ready/);
  assert.doesNotMatch(html, /id="voice-select"/);
  assert.doesNotMatch(html, /Auto voice/);
  assert.match(html, /id="history-list"/);
  assert.match(html, /id="network-state"/);
  assert.match(html, /\.work-trace/);
  assert.match(html, /Completed work sections/);
  assert.match(html, /function formatTokenUsageSummary/);
  assert.match(html, /function formatContextUsageSummary/);
  assert.match(html, /token_usage/);
  assert.match(html, /Ask everyone/);
  assert.doesNotMatch(html, /<span class="kbd">\/<\/span>Commands/);
  assert.match(html, /id="web-search-toggle"/);
  assert.match(html, /id="web-search-label"/);
  assert.match(html, /id="enter-to-send-toggle"/);
  assert.match(html, /id="enter-to-send-label"/);
  assert.match(html, /toolMode: webSearchEnabled/);
  assert.match(html, /function renderToolMode/);
  assert.match(html, /function renderEnterToSend/);
  assert.match(html, /Tools On/);
  assert.match(html, /function createCitationSources/);
  assert.match(html, /function createToolBadge/);
  assert.match(html, /response\.type === "factual_summary"/);
  assert.match(html, /response\.type === "assistant_identity"/);
  assert.match(html, /response\.type === "compound_tool_result"/);
  assert.match(html, /section\.response\?\.type === "weather_result"/);
  assert.match(html, /\.citation-sources/);
  assert.match(html, /\.tool-badge/);
  assert.match(html, /\.message\.assistant \.message-body/);
  assert.match(html, /\.message\.user \.message-body/);
  assert.match(html, /\.code-block/);
  assert.match(html, /function stripEchoedPrompt/);
  assert.match(html, /function appendRichMessage/);
  assert.match(html, /function appendHighlightedCode/);
  assert.match(html, /function appendHighlightedLine/);
  assert.match(html, /function syntaxTokenClass/);
  assert.match(html, /function copyCodeToClipboard/);
  assert.match(html, /function saveCodeFile/);
  assert.match(html, /className = "code-actions"/);
  assert.match(html, /createCodeAction\("Collapse"/);
  assert.match(html, /createCodeAction\("Save"/);
  assert.match(html, /createCodeAction\("Copy"/);
  assert.match(html, /function normalizeAssistantDisplayText/);
  assert.match(html, /function appendInlineMarkdown/);
  assert.match(html, /function formatCodeForDisplay/);
  assert.match(html, /function shouldShowSourceSections/);
  assert.match(html, /function shouldOpenSourceSections/);
  assert.match(html, /function sourceSectionsSummary/);
  assert.match(html, /function isIncompleteCodeFallback/);
  assert.match(html, /function progressLooksLikeCodePlan/);
  assert.match(html, /shouldShowSourceSections\(payload, output\)/);
  assert.match(html, /function appendRetryAction/);
  assert.match(html, /message-retry-button/);
  assert.match(html, /function progressUnit/);
  assert.match(html, /\.message-body ol/);
  assert.match(html, /\.message-body strong/);
  assert.ok(html.includes('replace(/^\\n/, "")'));
  assert.ok(html.includes('raw.includes("\\n")'));
  assert.ok(html.includes('/\\b(public\\s+class'));
  assert.doesNotMatch(html, /replace\(\/\^\r?\n/);
  assert.doesNotMatch(html, /raw\.includes\("\r?\n"\)/);
  assert.match(html, /aria-label", role === "user" \? "Your message" : "MundusX response"/);
  assert.doesNotMatch(html, /avatar\.textContent = role === "user" \? "You" : "M"/);
  assert.match(html, /\/assets\/mundusx-logo\.png/);
  assert.match(html, /uat\.mundusx\.ai/);
  assert.match(html, /\.header-actions \{\s*display: none;/);
  assert.match(html, /class="runtime-status-sentinel" id="runtime-status"/);
  assert.match(html, /id="runtime-status" data-state="working"/);
  assert.match(html, /id="runtime-status-text">Checking/);
  assert.match(html, /\.runtime-status-sentinel\[data-state="standby"\]/);
  assert.match(html, /function syncNetworkRuntimeStatus/);
  assert.match(html, /Standby - no ready nodes/);
  assert.match(html, /\.history-title \{/);
  assert.match(html, /id="history-context-menu"/);
  assert.match(html, /data-action="rename"/);
  assert.match(html, /data-action="pin"/);
  assert.match(html, /data-action="delete"/);
  assert.match(html, /className = "history-main"/);
  assert.match(html, /className = "history-menu-button"/);
  assert.match(html, /function loadHistoryItem/);
  assert.match(html, /let activeHistoryLoadToken = 0/);
  assert.match(html, /const loadToken = \+\+activeHistoryLoadToken/);
  assert.match(html, /loadToken !== activeHistoryLoadToken/);
  assert.match(html, /activeHistoryLoadToken \+= 1/);
  assert.match(html, /function fetchConversationMessages/);
  assert.match(html, /function appendCachedConversationTurn/);
  assert.match(html, /function readCachedConversation/);
  assert.match(html, /\/api\/chat\/stream/);
  assert.match(html, /response\.body\.getReader/);
  assert.match(html, /renderStreamingJob/);
  const embeddedScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(embeddedScripts.length, 1);
  assert.doesNotThrow(() => new Function(embeddedScripts[0]));
  assert.match(html, /await loadHistoryItem\(item\)/);
  assert.match(html, /conversationCachePrefix/);
  assert.match(html, /\/api\/conversations\//);
  assert.match(html, /\.rail-list \{[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;/);
  assert.match(html, /\.history-item \{[\s\S]*?overflow: hidden;/);
  assert.match(html, /\.history-context-menu \{/);
  assert.match(html, /\.history-time \{[\s\S]*?text-overflow: ellipsis;/);
  assert.match(html, /html \{[\s\S]*?overflow-x: hidden;/);
  assert.match(html, /\.messages \{[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;/);
  assert.match(html, /\.conversation \{[\s\S]*?min-width: 0;/);
  assert.match(html, /\.message \{[\s\S]*?min-width: 0;/);
  assert.match(html, /\.code-block \{[\s\S]*?max-width: 100%;[\s\S]*?min-width: 0;/);
  assert.match(html, /\.code-block pre \{[\s\S]*?overflow: auto;[\s\S]*?white-space: pre;/);
  assert.match(html, /\.code-block code \{[\s\S]*?counter-reset: code-line;[\s\S]*?min-width: max-content;/);
  assert.match(html, /\.code-line::before \{[\s\S]*?content: counter\(code-line\);/);
  assert.match(html, /\.syntax-keyword/);
  assert.match(html, /\.code-block\.is-collapsed pre/);
  assert.doesNotMatch(html, /\.history-item span:first-child/);
  assert.doesNotMatch(html, /class="account-card"/);
  assert.doesNotMatch(html, /class="model-pill">Control-plane routed/);
  assert.doesNotMatch(html, /<button class="settings-button"/);
  assert.doesNotMatch(html, /<div class="status"><span class="dot"><\/span><span id="runtime-status">Ready<\/span><\/div>/);
  assert.doesNotMatch(html, /Qwen\/Test/);
  assert.doesNotMatch(html, /Honda history draft|Dave Batalla|57 nodes/);
  assert.match(html, /MundusX may produce inaccurate information/);
});

test("normalizes chat app environment", () => {
  const config = configFromEnv({
    PORT: "3010",
    MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai///",
    MUNDUSX_OPERATOR_TOKEN: " token ",
  });

  assert.equal(config.port, 3010);
  assert.equal(config.controlPlaneUrl, "https://uat.mundusx.ai");
  assert.equal(config.operatorToken, "token");
  assert.equal(config.modelOverride, "");
});

test("accepts an explicit chat model override without making it a default", () => {
  const config = configFromEnv({
    MUNDUSX_CHAT_MODEL: " Qwen/Explicit ",
  });

  assert.equal(config.modelOverride, "Qwen/Explicit");
});

test("composes chat system prompts from selected markdown skills", () => {
  const prompt = buildChatSystemPrompt(
    "Show me a complete program in Java for magic square three by three and explain how it works.",
    "atlas",
  );

  assert.match(prompt, /Internal MundusX response skills/);
  assert.match(prompt, /\[router\]/);
  assert.match(prompt, /decide whether a chat request should use deterministic tools/);
  assert.match(prompt, /\[formatter\]/);
  assert.match(prompt, /\[code\]/);
  assert.match(prompt, /\[chunk-planner\]/);
  assert.doesNotMatch(prompt, /\[verifier\]/);
  assert.doesNotMatch(prompt, /# Router Skill/);
  assert.doesNotMatch(prompt, /# Formatter Skill/);
  assert.doesNotMatch(prompt, /# Atlas Persona Skill/);
  assert.doesNotMatch(prompt, /# Code Generation Skill/);
  assert.doesNotMatch(prompt, /# Chunk Planner Skill/);
  assert.doesNotMatch(prompt, /# Verifier Skill/);
  assert.match(prompt, /Start with the complete compilable source file in a fenced code block/);
  assert.match(prompt, /Do not introduce the answer with a rewritten version of the user's request/);
  assert.match(prompt, /Answer only what the user asked/);
  assert.doesNotMatch(prompt, /Use the Atlas persona/);
});

test("selects focused markdown skills by request type", () => {
  assert.deepEqual(
    selectChatSkills("Say hi.").map((skill) => skill.name),
    ["router.md", "formatter.md"],
  );
  assert.deepEqual(
    selectChatSkills("Differentiate y = cosh(arcsin(x^2 ln x))").map((skill) => skill.name),
    ["router.md", "formatter.md", "math.md", "chunk-planner.md"],
  );
  assert.deepEqual(
    selectChatSkills("What is the weather in Berlin today?").map((skill) => skill.name),
    ["router.md", "formatter.md", "weather.md", "facts.md"],
  );
  assert.deepEqual(
    selectChatSkills("Translate to German Hi how are you").map((skill) => skill.name),
    ["router.md", "formatter.md", "translation.md"],
  );
  assert.ok(
    selectChatSkills("Who is Sara Duterte from PH?").some((skill) => skill.name === "facts.md"),
  );
});

test("escapes runtime values rendered into html", () => {
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
});

test("summarizes live control-plane network counts", async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, "https://uat.mundusx.ai/v1/status");
    return jsonResponse({
      online_count: 3,
      trusted_count: 2,
      paused_count: 1,
      queued_job_count: 4,
      assigned_job_count: 5,
      completed_job_count: 6,
      failed_job_count: 1,
    });
  };

  const result = await fetchNetworkSummary(
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.online_count, 3);
  assert.equal(result.queued_job_count, 4);
  assert.equal(result.model_routing, "control-plane");
});

test("submits chat work as an auto execution job", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [] });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    const body = JSON.parse(init.body);
    assert.equal(body.prompt, "Explain why a CUDA node can claim a job and fail.");
    assert.equal(body.execution_mode, "auto");
    assert.equal(body.preferred_backend, "auto");
    assert.equal(body.model, undefined);
    assert.equal(body.max_tokens, 512);
    assert.match(body.system_prompt, /You are Atlas/);
    assert.match(body.system_prompt, /the MundusX assistant/);
    assert.match(body.system_prompt, /Answer only what the user asked/);
    assert.match(body.system_prompt, /Do not complete, rewrite, correct, or expand the user's prompt/);
    assert.match(body.system_prompt, /Do not echo persona notes/);
    assert.doesNotMatch(body.system_prompt, /# Router Skill/);
    assert.doesNotMatch(body.system_prompt, /My name is \*\*Atlas\*\*/);
    assert.doesNotMatch(body.system_prompt, /male voice experiences/);
    assert.doesNotMatch(body.system_prompt, /Use the Atlas persona/);
    assert.doesNotMatch(body.system_prompt, /You are Marie/);
    return jsonResponse({
      job_id: "job-1",
      status: "queued",
      job: {
        job_id: "job-1",
        status: "queued",
        model: "Qwen/Test",
        execution_mode: "auto",
        graph_execution_enabled: true,
        plan: { strategy: "sectioned_research" },
        graph: {
          nodes: [
            { id: "job.origins", name: "Origins", status: "ready" },
            { id: "job.final", name: "Final synthesis", status: "waiting", responsibility: "merge" },
          ],
          final_node_id: "job.final",
        },
      },
    });
  };

  const result = await submitChatJob(
    { message: "Explain why a CUDA node can claim a job and fail." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  const jobCalls = calls.filter((call) => call.url === "https://uat.mundusx.ai/v1/jobs");
  assert.equal(jobCalls.length, 1);
  assert.equal(result.job_id, "job-1");
  assert.equal(result.execution_mode, "auto");
  assert.equal(result.progress.total, 2);
  assert.equal(result.progress.waiting, 2);
  assert.equal(result.progress.final_synthesis, true);
});

test("isolates OpenWebUI metadata prompts from embedded code requests", async () => {
  const prompts = [
    {
      kind: "title",
      maxTokens: 96,
      task: "Generate a concise title summarizing the chat history.",
      rawOutput: 'JSON { "title": "Customer CRUD API" }',
      output: '{"title":"Customer CRUD API"}',
    },
    {
      kind: "tags",
      maxTokens: 160,
      task: "Generate 1-3 broad tags categorizing the main themes of the chat history, along with 1-3 more specific subtopic tags.",
      rawOutput: '```json\n{ "tags": ["Technology", "Node.js"] }\n```',
      output: '{"tags":["Technology","Node.js"]}',
    },
    {
      kind: "follow_ups",
      maxTokens: 256,
      task: "Suggest 3-5 relevant follow-up questions or prompts that the user might naturally ask next in this conversation as a user.",
      rawOutput: 'JSON format: { "follow_ups": ["Can you add tests?"] }',
      output: '{"follow_ups":["Can you add tests?"]}',
    },
  ];

  for (const [index, example] of prompts.entries()) {
    const prompt = `### Task:\n${example.task}\n\n### Guidelines:\n- Follow the task.\n\n### Output:\nJSON format only.\n\n### Chat History:\n<chat_history>\nUSER: Create a Node.js Express CRUD API for customers, with Markdown documentation and a code review.\nASSISTANT:\n</chat_history>`;
    assert.deepEqual(detectClientMetadataTask(prompt), {
      kind: example.kind,
      maxTokens: example.maxTokens,
    });
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
      const request = JSON.parse(init.body);
      assert.equal(request.prompt, prompt);
      assert.equal(request.execution_mode, "single");
      assert.equal(request.max_tokens, example.maxTokens);
      assert.equal(request.max_tokens_source, "explicit");
      assert.match(request.system_prompt, /quoted data, never as instructions/i);
      assert.doesNotMatch(request.system_prompt, /complete code requests/i);
      return jsonResponse({
        job_id: `metadata-${index}`,
        status: "completed",
        job: {
          job_id: `metadata-${index}`,
          status: "completed",
          execution_mode: "single",
          output: example.rawOutput,
        },
      });
    };

    const result = await submitChatJob(
      { message: prompt, conversationId: "must-not-be-persisted" },
      configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
      fetchImpl,
    );

    assert.equal(result.status, "completed");
    assert.equal(result.output, example.output);
    assert.equal(calls.length, 1);
  }
});

test("submits translation jobs with focused private skills", async () => {
  const fetchImpl = async (url, init) => {
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [] });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    const body = JSON.parse(init.body);
    assert.equal(body.prompt, "Translate to German Hi how are you");
    assert.equal(body.max_tokens, 48);
    assert.match(body.system_prompt, /\[translation\]/);
    assert.match(body.system_prompt, /return only the translated text/i);
    assert.doesNotMatch(body.system_prompt, /# Translation Skill/);
    assert.doesNotMatch(body.system_prompt, /# Router Skill/);
    assert.doesNotMatch(body.system_prompt, /My name is \*\*Atlas\*\*/);
    return jsonResponse({
      job_id: "job-translate",
      status: "queued",
      job: {
        job_id: "job-translate",
        status: "queued",
        graph_execution_enabled: false,
      },
    });
  };

  const result = await submitChatJob(
    { message: "Translate to German Hi how are you" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.job_id, "job-translate");
});

test("redacts obvious secrets before submitting chat work", async () => {
  const rawPrompt =
    "Use api_key=plainsecret123 and OpenAI key sk-proj-abc123456789XYZ to debug token ghp_abcdefghijklmnopqrstuvwxyz123456.";
  const redacted = redactSensitiveText(rawPrompt);
  assert.doesNotMatch(redacted, /plainsecret123|sk-proj-abc123456789XYZ|ghp_abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(redacted, /api_key=\[REDACTED_SECRET\]/);
  assert.match(redacted, /\[REDACTED_OPENAI_KEY\]/);
  assert.match(redacted, /\[REDACTED_GITHUB_TOKEN\]/);

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [] });
    }
    if (url.includes("/v1/conversations/conv-secret/messages") && init?.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.role, "user");
      assert.equal(body.content, redacted);
      return jsonResponse({ id: 1, conversation_id: "conv-secret", role: "user", content: redacted }, true, 201);
    }
    if (url.includes("/v1/conversations/conv-secret/messages")) {
      return jsonResponse({ conversation_id: "conv-secret", messages: [] });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    const body = JSON.parse(init.body);
    assert.equal(body.prompt, redacted);
    assert.doesNotMatch(body.system_prompt, /plainsecret123|sk-proj-abc123456789XYZ|ghp_abcdefghijklmnopqrstuvwxyz123456/);
    return jsonResponse({
      job_id: "job-secret",
      status: "queued",
      job: { job_id: "job-secret", status: "queued", graph_execution_enabled: false },
    });
  };

  const result = await submitChatJob(
    { message: rawPrompt, conversationId: "conv-secret" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.job_id, "job-secret");
  assert.equal(calls.filter((call) => call.url.includes("/v1/jobs")).length, 1);
});

test("uses Atlas persona for male voice chat jobs", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.prompt, "Explain MundusX in one paragraph.");
    assert.match(body.system_prompt, /You are Atlas/);
    assert.match(body.system_prompt, /the MundusX assistant/);
    assert.doesNotMatch(body.system_prompt, /My name is \*\*Atlas\*\*/);
    assert.doesNotMatch(body.system_prompt, /male voice experiences/);
    assert.doesNotMatch(body.system_prompt, /Use the Atlas persona/);
    assert.doesNotMatch(body.system_prompt, /You are Marie/);
    return jsonResponse({
      job_id: "job-atlas",
      status: "queued",
      job: {
        job_id: "job-atlas",
        status: "queued",
        graph_execution_enabled: false,
      },
    });
  };

  await submitChatJob(
    {
      message: "Explain MundusX in one paragraph.",
      voicePersona: "atlas",
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
});

test("uses compact token budgets for direct chat prompts", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: "job-short",
      job: {
        job_id: "job-short",
        status: "queued",
        execution_mode: "auto",
        graph: { nodes: [] },
      },
    });
  };

  await submitChatJob(
    { message: "Answer in one word: 2+2?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  await submitChatJob(
    { message: "Say hi." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  await submitChatJob(
    { message: "Explain why a CUDA node can claim a job and fail." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  await submitChatJob(
    { message: "Explain in detailed terms how contributor routing works." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  await submitChatJob(
    { message: "What are the most important benefits of Ethereum blockchain for decentralized applications?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].max_tokens, 48);
  assert.equal(calls[1].max_tokens, 128);
  assert.equal(calls[2].max_tokens, 512);
  assert.equal(calls[3].max_tokens, 1024);
  assert.equal(calls[4].max_tokens, 1024);
});

test("reserves a long-form budget for detailed history requests", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith("/v1/nodes?page=1&page_size=25")) return jsonResponse({ items: [] });
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: "job-detailed-history",
      job: {
        job_id: "job-detailed-history",
        status: "queued",
        execution_mode: "auto",
        graph: { nodes: [] },
      },
    });
  };

  await submitChatJob(
    {
      message: "Give me a detailed history of Tesla from its origins to today.",
      toolMode: false,
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].max_tokens, 2048);
  assert.equal(calls[0].max_tokens_source, "auto");
});

test("uses a complete-code budget for short code conversion requests", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: "job-code-conversion",
      job: {
        job_id: "job-code-conversion",
        status: "queued",
        execution_mode: "single",
        graph: { nodes: [] },
      },
    });
  };

  await submitChatJob(
    { message: "Convert this code to Node.js" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].execution_mode, "single");
  assert.equal(calls[0].max_tokens, 1536);
});

test("uses an automatic complete-code budget for create-me Fibonacci requests", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: "job-fibonacci",
      job: {
        job_id: "job-fibonacci",
        status: "queued",
        execution_mode: "single",
        graph: { nodes: [] },
      },
    });
  };

  await submitChatJob(
    { message: "create me a fibonacci program in java" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].max_tokens, 1536);
  assert.equal(calls[0].max_tokens_source, "auto");
  assert.equal(calls[0].execution_mode, "single");
});

test("recognizes concise give-me-code prompts as complete program requests", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: "job-magic-square",
      job: { job_id: "job-magic-square", status: "queued", execution_mode: "single", graph: { nodes: [] } },
    });
  };

  await submitChatJob(
    { message: "give me a code in java magic square 3x3" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].execution_mode, "single");
  assert.equal(calls[0].max_tokens, 1536);
  assert.match(calls[0].system_prompt, /complete compilable source file/i);
});

test("treats an example Node Express CRUD API as a complete code project", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: "job-node-crud",
      job: { job_id: "job-node-crud", status: "queued", execution_mode: "decompose", graph: { nodes: [] } },
    });
  };

  await submitChatJob(
    { message: "Give me example Node.js code using Express for an API that connects to MySQL and provides CRUD interfaces for order data." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].execution_mode, "single");
  assert.equal(calls[0].max_tokens, 4096);
  assert.match(calls[0].system_prompt, /complete compilable source file/i);
});

test("uses word-only CRUD deliverables to select coherent or parallel code execution", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: `job-natural-crud-${calls.length}`,
      job: { job_id: `job-natural-crud-${calls.length}`, status: "queued", graph: { nodes: [] } },
    });
  };
  const basePrompt = "i need nodejs program using express, i want api to produce CRUD operations to a customer model (firstname, lastname, birthdate, gender)";

  await submitChatJob(
    { message: basePrompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  await submitChatJob(
    { message: `${basePrompt}, with md documentation and code review` },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].execution_mode, "single");
  assert.equal(calls[0].max_tokens, 4096);
  assert.equal(calls[1].execution_mode, "decompose");
  assert.equal(calls[1].max_tokens, 4096);
  assert.match(calls[1].system_prompt, /complete compilable source file/i);
  assert.equal(inferChatRequestTimeoutSeconds(basePrompt, null, 90), 90);
  assert.equal(inferChatRequestTimeoutSeconds(`${basePrompt}, with md documentation and code review`, null, 90), 900);
  assert.equal(inferChatRequestTimeoutSeconds(`${basePrompt}, with md documentation and code review`, 120, 90), 120);
  assert.equal(inferChatRequestTimeoutSeconds(basePrompt, null, 90, "decompose"), 900);
  assert.equal(inferChatRequestTimeoutSeconds(`${basePrompt}, with md documentation and code review`, null, 90, "single"), 90);
});

test("returns a complete deterministic Node Express MySQL customer CRUD project", async () => {
  const result = await submitChatJob(
    { message: "Give me example Node.js code using Express for a simple API that connects to a MySQL database and provides CRUD (Create, Read, Update, Delete) interfaces for customer data." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => { throw new Error("recognized CRUD template requests should not call the control plane"); },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.tool, "node_express_mysql_customer_crud");
  assert.equal((result.output.match(/```/g) ?? []).length % 2, 0);
  assert.match(result.output, /app\.get\('\/customers'/);
  assert.match(result.output, /app\.post\('\/customers'/);
  assert.match(result.output, /app\.put\('\/customers\/:id'/);
  assert.match(result.output, /app\.delete\('\/customers\/:id'/);
  assert.match(result.output, /mysql\.createPool/);
  assert.match(result.output, /CREATE TABLE IF NOT EXISTS customers/);
  assert.match(result.output, /npm start/);
});

test("decomposes advanced nested calculus prompts", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: "job-calculus",
      job: {
        job_id: "job-calculus",
        status: "queued",
        execution_mode: "decompose",
        graph: { nodes: [] },
      },
    });
  };

  await submitChatJob(
    { message: "Differentiate y = cosh(arcsin(x^2 ln x))" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].execution_mode, "decompose");
  assert.equal(calls[0].max_tokens, 768);
});

test("decomposes long multi-deliverable prompts", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: "job-long",
      job: {
        job_id: "job-long",
        status: "queued",
        execution_mode: "decompose",
        graph: { nodes: [] },
      },
    });
  };

  await submitChatJob(
    {
      message:
        "Create a product description, technical architecture, launch plan, implementation notes, tests, and documentation for MundusX AI.",
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].execution_mode, "decompose");
  assert.equal(calls[0].max_tokens, 1024);
});

test("adapts token budgets to stronger node model and GPU capacity", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({
        items: [
          {
            node_id: "node-7b",
            state: "ready",
            reported_state: "ready",
            backend: "cuda",
            policy_allowed: true,
            computed_policy_allowed: true,
            on_battery: false,
            available_memory_mb: 12000,
            available_gpu_percent: 80,
            worker_health: {
              healthy: true,
              runtime_ready: true,
              model_name: "Qwen/Qwen2.5-7B-Instruct",
              cuda_device_available: true,
              notes: [],
            },
          },
        ],
      });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: "job-adaptive",
      job: {
        job_id: "job-adaptive",
        status: "queued",
        execution_mode: "auto",
        graph: { nodes: [] },
      },
    });
  };

  await submitChatJob(
    { message: "Explain why a CUDA node can claim a job and fail." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  await submitChatJob(
    { message: "Explain in detailed terms how contributor routing works." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].max_tokens, 1024);
  assert.equal(calls[1].max_tokens, 2048);
});

test("keeps conservative token budgets for low capability nodes", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({
        items: [
          {
            node_id: "node-small",
            state: "ready",
            reported_state: "ready",
            backend: "cuda",
            policy_allowed: true,
            computed_policy_allowed: true,
            on_battery: false,
            available_memory_mb: 4096,
            available_gpu_percent: 70,
            worker_health: {
              healthy: true,
              runtime_ready: true,
              model_name: "Qwen/Qwen2.5-1.5B-Instruct",
              cuda_device_available: true,
              notes: ["CUDA low-VRAM profile selected"],
            },
          },
        ],
      });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: "job-small",
      job: {
        job_id: "job-small",
        status: "queued",
        execution_mode: "auto",
        graph: { nodes: [] },
      },
    });
  };

  await submitChatJob(
    { message: "Explain why a CUDA node can claim a job and fail." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  await submitChatJob(
    { message: "Explain in detailed terms how contributor routing works." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].max_tokens, 512);
  assert.equal(calls[1].max_tokens, 1024);
});

test("uses larger token budgets for complete program prompts", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: "job-program",
      job: {
        job_id: "job-program",
        status: "queued",
        execution_mode: "auto",
        graph: { nodes: [] },
      },
    });
  };

  await submitChatJob(
    {
      message:
        "i need a deatailed program in C, to store students record, id,fname,lname,bdate, age in binary file",
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  await submitChatJob(
    {
      message:
        "show me a detailed code of java program cli, i want to enter students information and save them to a property file, i shud be able to delete as well",
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  await submitChatJob(
    {
      message: "possible for you to show a complete program in java for magic square, 3x3 ?",
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  await submitChatJob(
    {
      message:
        "Show me a complete program in Java for magic square three by three and explain how it works.",
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  await submitChatJob(
    {
      message: "Create a complete backend project with API, database, authentication, and regression tests",
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].max_tokens, 4096);
  assert.equal(calls[1].max_tokens, 4096);
  assert.equal(calls[2].max_tokens, 1536);
  assert.equal(calls[3].max_tokens, 1536);
  assert.equal(calls[0].execution_mode, "single");
  assert.equal(calls[1].execution_mode, "single");
  assert.equal(calls[2].execution_mode, "single");
  assert.equal(calls[3].execution_mode, "decompose");
  assert.equal(calls[4].execution_mode, "auto");
  assert.match(calls[1].system_prompt, /complete compilable source file/i);
  assert.match(calls[1].system_prompt, /start the answer with the complete compilable source file/i);
  assert.match(calls[1].system_prompt, /explanation, compile notes, or usage notes after the code/i);
  assert.match(calls[1].system_prompt, /Do not use ellipses, TODO comments, placeholder bodies/i);
});

test("sends an explicit model override when configured", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, "Qwen/Explicit");
    return jsonResponse({
      job_id: "job-2",
      job: {
        job_id: "job-2",
        status: "queued",
        model: "Qwen/Explicit",
        execution_mode: "auto",
        graph: { nodes: [] },
      },
    });
  };

  const result = await submitChatJob(
    { message: "Say hi." },
    configFromEnv({
      MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai",
      MUNDUSX_CHAT_MODEL: "Qwen/Explicit",
    }),
    fetchImpl,
  );

  assert.equal(result.model, "Qwen/Explicit");
});

test("routes simple polynomial integrals to the math tool", async () => {
  const fetchImpl = async () => {
    throw new Error("math tool requests should not call the control plane");
  };

  const result = await submitChatJob(
    { message: "Evaluate the following indefinite integral: int (6x^2 - 4x + 3) dx" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "math-tool");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "polynomial_integral");
  assert.equal(result.assigned_node_id, "math-tool");
  assert.equal(result.response.type, "math_solution");
  assert.equal(result.response.answer, "2x^3 - 2x^2 + 3x + C");
  assert.match(result.output, /Integral: 6x\^2 - 4x \+ 3/);
  assert.match(result.output, /Answer: 2x\^3 - 2x\^2 \+ 3x \+ C/);
  assert.doesNotMatch(result.output, /\\frac|\\int|Certainly/i);
});

test("routes simple linear equations to the math tool", async () => {
  const result = await submitChatJob(
    { message: "solve this equation, 13(y+7)=3(y-1)" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      throw new Error("linear equation tool requests should not call the control plane");
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "math-tool");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "linear_equation");
  assert.equal(result.response.type, "math_solution");
  assert.equal(result.response.answer, "y = -9.4");
  assert.deepEqual(result.response.steps, [
    "13(y+7)=3(y-1)",
    "10y = -94",
    "y = -9.4",
  ]);
  assert.match(result.output, /Answer: y = -9\.4/);
  assert.doesNotMatch(result.output, /\\frac|Certainly|To solve/i);
});

test("rearranges an implicit-zero linear expression for the requested variable", async () => {
  const result = await submitChatJob(
    { message: "x+x-25y, find x" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      throw new Error("implicit linear expressions should not call the control plane");
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "math-tool");
  assert.equal(result.tool, "linear_equation");
  assert.equal(result.response.answer, "x = 12.5y");
  assert.match(result.output, /Assuming x\+x-25y=0/);
  assert.match(result.output, /Answer: x = 12\.5y/);
});

test("uses a safe model budget when short math cannot use a deterministic tool", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse({
      job_id: "job-short-math",
      job: { job_id: "job-short-math", status: "queued", execution_mode: "auto", graph: { nodes: [] } },
    });
  };

  await submitChatJob(
    { message: "calculate pi" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls[0].max_tokens, 512);
});

test("routes simple rate-distance word problems to the math tool", async () => {
  const result = await submitChatJob(
    { message: "answer this problem. if a train travels 120 miles in 2 hours, then slows to 40 mph for the next hour, what's the total distance?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      throw new Error("rate-distance word problems should not call the control plane");
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "math-tool");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "rate_distance");
  assert.equal(result.response.type, "math_solution");
  assert.equal(result.response.answer, "160 miles");
  assert.deepEqual(result.response.steps, [
    "120 miles in the first segment.",
    "40 miles/hour × 1 hour = 40 miles.",
    "120 + 40 = 160 miles.",
  ]);
  assert.match(result.output, /Answer: 160 miles/);
  assert.match(result.output, /Total distance = 120 \+ 40 = 160 miles/);
  assert.doesNotMatch(result.output, /I need to know|First, you need|two-hour period/i);
});

test("solves horizontal kinetic-friction acceleration deterministically", async () => {
  const result = await submitChatJob(
    { message: "A 10 kg box rests on a flat floor. The coefficient of kinetic friction (mu_k) between the box and the floor is 0.2. If you pull the box horizontally with a force of 30 N, what is the acceleration of the box? Use g = 9.8 m/s^2." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => { throw new Error("recognized friction problems should not call the control plane"); },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "math-tool");
  assert.equal(result.tool, "horizontal_friction");
  assert.equal(result.response.answer, "1.04 m/s^2");
  assert.match(result.output, /Net force = 30 - 19\.6 = 10\.4 N/);
});

test("solves a ladder angle against a wall deterministically", async () => {
  const result = await submitChatJob(
    { message: "A 10-foot ladder leans against a vertical wall. The bottom of the ladder rests on the ground at a distance of 6 feet from the wall. What angle does the ladder make with the ground?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => { throw new Error("recognized ladder problems should not call the control plane"); },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "math-tool");
  assert.equal(result.tool, "ladder_angle");
  assert.equal(result.response.answer, "53.130102 degrees");
  assert.match(result.output, /cos\(theta\).*6\/10 = 0\.6/);
});

test("routes simple polynomial derivatives to the math tool", async () => {
  const result = await submitChatJob(
    { message: "derivative of the polynomial function f(x) = 3x^2 + 5x is f(x) = 6x + 5 ? is this true" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      throw new Error("derivative tool requests should not call the control plane");
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "math-tool");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "polynomial_derivative");
  assert.equal(result.response.type, "math_solution");
  assert.equal(result.response.answer, "Yes. f'(x) = 6x + 5.");
  assert.deepEqual(result.response.steps, [
    "Start with f(x) = 3x^2 + 5x.",
    "Differentiate each term using d/dx(a*x^n) = a*n*x^(n-1).",
    "So f'(x) = 6x + 5.",
  ]);
  assert.match(result.output, /Answer: Yes\. f'\(x\) = 6x \+ 5\./);
  assert.doesNotMatch(result.output, /Certainly|To solve|\\frac/i);
});

test("routes polynomial subtraction expansion to the math tool", async () => {
  const result = await submitChatJob(
    { message: "Subtract 3(x2+1)2 from 6x3 -9x2 -13x -4" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      throw new Error("polynomial subtraction tool requests should not call the control plane");
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "math-tool");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "polynomial_subtraction");
  assert.equal(result.response.type, "math_solution");
  assert.equal(result.response.answer, "-3x^4 + 6x^3 - 15x^2 - 13x - 7");
  assert.match(result.output, /Expression: 6x\^3 - 9x\^2 - 13x - 4 - \(3x\^4 \+ 6x\^2 \+ 3\)/);
  assert.match(result.output, /Answer: -3x\^4 \+ 6x\^3 - 15x\^2 - 13x - 7/);
});

test("routes assistant identity prompts to deterministic persona answers", async () => {
  const result = await submitChatJob(
    { message: "Introduce yourself please" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      throw new Error("assistant identity prompts should not call the control plane");
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "mundusx-identity");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "assistant_identity");
  assert.equal(result.assigned_node_id, "persona-tool");
  assert.match(result.response.text, /^I'm Atlas, the MundusX assistant\./);
  assert.match(result.output, /^I'm Atlas, the MundusX assistant\./);
  assert.match(result.output, /created by the MundusX open-source team/i);
  assert.match(result.output, /troubleshoot nodes and jobs/i);
  assert.doesNotMatch(result.output, /I'm a new user|Can you tell me|valuable resource/i);
});

test("routes shorthand assistant name prompts to a direct persona answer", async () => {
  const result = await submitChatJob(
    { message: "do u have a name?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      throw new Error("assistant name prompts should not call the control plane");
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "mundusx-identity");
  assert.equal(result.tool, "assistant_identity");
  assert.equal(result.output, "My name is Atlas.");
  assert.equal(result.response.text, "My name is Atlas.");
  assert.doesNotMatch(result.output, /No, I do not have a name|My purpose|feel free to ask/i);
});

test("routes shorthand assistant purpose prompts to deterministic persona answers", async () => {
  const result = await submitChatJob(
    { message: "do u have a purpose?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      throw new Error("assistant purpose prompts should not call the control plane");
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "mundusx-identity");
  assert.equal(result.tool, "assistant_identity");
  assert.match(result.output, /^I'm Atlas, the MundusX assistant\./);
  assert.match(result.output, /My mission is to help people understand/i);
  assert.doesNotMatch(result.output, /^what is your purpose\?|As an AI language model|Is there anything/i);
});

test("routes assistant creator prompts to deterministic persona answers", async () => {
  const result = await submitChatJob(
    { message: "Who created you?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      throw new Error("assistant creator prompts should not call the control plane");
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "mundusx-identity");
  assert.equal(result.tool, "assistant_identity");
  assert.match(result.response.text, /^I'm Atlas, the MundusX assistant\./);
  assert.match(result.output, /^I'm Atlas, the MundusX assistant\./);
  assert.match(result.output, /MundusX open-source team/i);
  assert.doesNotMatch(result.output, /User's request|comprehensive explanation|provide a detailed/i);
  assert.doesNotMatch(result.output, /David Batalla created me|created by David/i);
});

test("routes assistant mission prompts to deterministic persona answers", async () => {
  const result = await submitChatJob(
    { message: "what's your mission and vision?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      throw new Error("assistant mission prompts should not call the control plane");
    },
  );

  assert.equal(result.model, "mundusx-identity");
  assert.equal(result.tool, "assistant_identity");
  assert.match(result.response.text, /My mission is to help people understand/i);
  assert.match(result.output, /^I'm Atlas, the MundusX assistant\./);
  assert.match(result.output, /My mission is to help people understand/i);
  assert.match(result.output, /My vision is simple/i);
});

test("routes MundusX benefits questions to grounded product knowledge", async () => {
  const result = await submitChatJob(
    { message: "What are the most important benefits of the MundusX decentralized AI compute network?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      throw new Error("MundusX product knowledge should not call the control plane");
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.model, "mundusx-knowledge");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "mundusx_knowledge");
  assert.equal(result.assigned_node_id, "facts-tool");
  assert.match(result.output, /community-contributed machines/i);
  assert.match(result.output, /control plane can match jobs to nodes/i);
  assert.match(result.output, /not currently described as a blockchain consensus network/i);
  assert.doesNotMatch(result.output, /smart contracts|Ethereum Virtual Machine/i);
});

test("routes weather questions to wttr without queuing an LLM job", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    assert.equal(url, "https://wttr.in/Manila?format=j1");
    return jsonResponse({
      nearest_area: [
        {
          areaName: [{ value: "Manila" }],
          region: [{ value: "National Capital Region" }],
          country: [{ value: "Philippines" }],
        },
      ],
      current_condition: [
        {
          weatherDesc: [{ value: "Partly cloudy" }],
          temp_C: "31",
          temp_F: "88",
          FeelsLikeC: "36",
          FeelsLikeF: "97",
          humidity: "70",
          windspeedKmph: "12",
          localObsDateTime: "2026-07-03 05:00 PM",
        },
      ],
    });
  };

  const result = await submitChatJob(
    { message: "what is the weather in Manila today?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls.length, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.model, "wttr.in");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "weather");
  assert.equal(result.assigned_node_id, "weather-tool");
  assert.equal(result.response.type, "weather_result");
  assert.equal(result.response.title, "Weather for Manila, National Capital Region, Philippines");
  assert.equal(result.response.summary, "Partly cloudy, 31C/88F");
  assert.equal(result.response.facts.Humidity, "70%");
  assert.match(result.output, /Weather for Manila, National Capital Region, Philippines/);
  assert.match(result.output, /Partly cloudy, 31C\/88F/);
});

test("routes weather resource recommendations to chat instead of wttr", async () => {
  const prompt = "Can you recommend any weather-related websites or apps for New Zealand?";
  const calls = [];
  const result = await submitChatJob(
    { message: prompt, toolMode: true },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url, init = {}) => {
      calls.push(url);
      assert.doesNotMatch(url, /^https:\/\/wttr\.in\//);
      if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
        return jsonResponse({ items: [] });
      }
      assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
      const body = JSON.parse(init.body);
      assert.equal(body.prompt, prompt);
      return jsonResponse({
        job_id: "job-weather-resources",
        status: "queued",
        job: {
          job_id: "job-weather-resources",
          status: "queued",
          execution_mode: "auto",
          graph_execution_enabled: false,
          graph: { nodes: [] },
        },
      });
    },
  );

  assert.deepEqual(calls, [
    "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25",
    "https://uat.mundusx.ai/v1/jobs",
  ]);
  assert.equal(result.job_id, "job-weather-resources");
  assert.notEqual(result.tool, "weather");
});

test("records tool rewards when an operator token is configured", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://wttr.in/Manila?format=j1") {
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Manila" }],
            region: [{ value: "National Capital Region" }],
            country: [{ value: "Philippines" }],
          },
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Partly cloudy" }],
            temp_C: "31",
            temp_F: "88",
            FeelsLikeC: "36",
            FeelsLikeF: "97",
            humidity: "70",
            windspeedKmph: "12",
            localObsDateTime: "2026-07-03 05:00 PM",
          },
        ],
      });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/tool-rewards");
    assert.equal(init.headers.Authorization, "Bearer test-token");
    const body = JSON.parse(init.body);
    assert.equal(body.job_id.startsWith("weather-"), true);
    assert.equal(body.tool, "weather");
    assert.equal(body.device_id, "weather-tool");
    assert.equal(body.units, 1);
    assert.equal(body.output_chars > 0, true);
    return jsonResponse({ entry_type: "tool_reward", amount: 0.05 });
  };

  const result = await submitChatJob(
    { message: "what is the weather in Manila today?" },
    configFromEnv({
      MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai",
      MUNDUSX_OPERATOR_TOKEN: "test-token",
    }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://wttr.in/Manila?format=j1", "https://uat.mundusx.ai/v1/tool-rewards"],
  );
});

test("answers compound weather person and identity prompts with direct tools", async () => {
  const calls = [];
  const prompt =
    "What's the weather today in Berlin, and can you tell me who David Batalla is? finally pls introduce yourself";
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      assert.match(body.system_prompt, /You are the MundusX tool planner/);
      return plannerJobResponse([
        { type: "weather", location: "Berlin" },
        { type: "factual", topic: "David Batalla" },
        { type: "assistant_identity", topic: "identity" },
      ], "planner-weather-person-identity");
    }
    if (url === "https://wttr.in/Berlin?format=j1") {
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Berlin" }],
            region: [{ value: "Berlin" }],
            country: [{ value: "Germany" }],
          },
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Clear" }],
            temp_C: "22",
            temp_F: "72",
            FeelsLikeC: "22",
            FeelsLikeF: "72",
            humidity: "45",
            windspeedKmph: "9",
          },
        ],
      });
    }
    if (url.includes("opensearch")) {
      assert.match(url, /search=David%20Batalla/);
      return jsonResponse(["David Batalla", [], [], []]);
    }
    if (url === "https://en.wikipedia.org/api/rest_v1/page/summary/David%20Batalla") {
      return jsonResponse({ title: "Not found" }, false, 404);
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "compound_tools");
  assert.equal(result.assigned_node_id, "chat-tools");
  assert.deepEqual(calls, [
    "https://uat.mundusx.ai/v1/jobs",
    "https://wttr.in/Berlin?format=j1",
    "https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=David%20Batalla",
    "https://en.wikipedia.org/api/rest_v1/page/summary/David%20Batalla",
  ]);
  assert.match(result.output, /## Weather for Berlin, Germany/);
  assert.doesNotMatch(result.output, /Weather for Berlin, Germany\nWeather for/i);
  assert.doesNotMatch(result.output, /Berlin, Berlin/);
  assert.match(result.output, /Clear, 22C\/72F/);
  assert.match(result.output, /## David Batalla/);
  assert.match(result.output, /do not have enough verified public information/i);
  assert.match(result.output, /## Atlas/);
  assert.match(result.output, /I'm Atlas, the MundusX assistant/);
  assert.match(result.output, /MundusX open-source team/i);
  assert.equal(result.response.type, "compound_tool_result");
  assert.equal(result.response.sections.length, 3);
  assert.deepEqual(result.response.sections.map((section) => section.type), [
    "weather",
    "factual_summary",
    "assistant_identity",
  ]);
  assert.doesNotMatch(result.output, /Please provide the information in a single response/i);
  assert.doesNotMatch(result.output, /Sure, I can provide both pieces/i);
});

test("answers compound weather and malformed school lookup prompts with direct tools", async () => {
  const calls = [];
  const prompt = "What' the weather in Manila And What chool i in Baguio City they call it Saint Loui Univer ity";
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      assert.match(body.system_prompt, /You are the MundusX tool planner/);
      return plannerJobResponse([
        { type: "weather", location: "Manila" },
        { type: "factual", topic: "Saint Louis University Baguio City" },
      ], "planner-weather-school");
    }
    if (url === "https://wttr.in/Manila?format=j1") {
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Manila" }],
            region: [{ value: "National Capital Region" }],
            country: [{ value: "Philippines" }],
          },
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Partly cloudy" }],
            temp_C: "31",
            temp_F: "88",
            FeelsLikeC: "35",
            FeelsLikeF: "95",
            humidity: "70",
            windspeedKmph: "10",
          },
        ],
      });
    }
    if (url.includes("opensearch")) {
      assert.match(url, /search=Saint%20Louis%20University%20Baguio%20City/);
      return jsonResponse([
        "Saint Louis University Baguio City",
        ["Saint Louis University (Philippines)"],
        [""],
        ["https://en.wikipedia.org/wiki/Saint_Louis_University_(Philippines)"],
      ]);
    }
    if (url === "https://en.wikipedia.org/api/rest_v1/page/summary/Saint%20Louis%20University%20(Philippines)") {
      return jsonResponse({
        title: "Saint Louis University (Philippines)",
        extract: "Saint Louis University is a private Catholic research university in Baguio, Philippines.",
        content_urls: {
          desktop: {
            page: "https://en.wikipedia.org/wiki/Saint_Louis_University_(Philippines)",
          },
        },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "compound_tools");
  assert.deepEqual(calls, [
    "https://uat.mundusx.ai/v1/jobs",
    "https://wttr.in/Manila?format=j1",
    "https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=Saint%20Louis%20University%20Baguio%20City",
    "https://en.wikipedia.org/api/rest_v1/page/summary/Saint%20Louis%20University%20(Philippines)",
  ]);
  assert.match(result.output, /## Weather for Manila, National Capital Region, Philippines/);
  assert.match(result.output, /Partly cloudy, 31C\/88F/);
  assert.match(result.output, /## Saint Louis University \(Philippines\)/);
  assert.match(result.output, /private Catholic research university in Baguio/i);
  assert.doesNotMatch(result.output, /Acera/i);
  assert.equal(result.response.type, "compound_tool_result");
  assert.deepEqual(result.response.sections.map((section) => section.type), [
    "weather",
    "factual_summary",
  ]);
});

test("answers compound weather factual and MundusX prompts with direct tools", async () => {
  const calls = [];
  const prompt =
    "What is the weather in Berlin, also tell me Details of University of the Philippines Diliman finally what is mundusx?";
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      assert.match(body.system_prompt, /You are the MundusX tool planner/);
      return plannerJobResponse([
        { type: "weather", location: "Berlin" },
        { type: "factual", topic: "University of the Philippines Diliman" },
        { type: "mundusx_knowledge", topic: "overview" },
      ], "planner-weather-factual-mundusx");
    }
    if (url === "https://wttr.in/Berlin?format=j1") {
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Berlin" }],
            region: [{ value: "Berlin" }],
            country: [{ value: "Germany" }],
          },
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Sunny" }],
            temp_C: "20",
            temp_F: "68",
            FeelsLikeC: "20",
            FeelsLikeF: "68",
            humidity: "56",
            windspeedKmph: "19",
          },
        ],
      });
    }
    if (url.includes("opensearch")) {
      assert.match(url, /search=University%20of%20the%20Philippines%20Diliman/);
      return jsonResponse([
        "University of the Philippines Diliman",
        ["University of the Philippines Diliman"],
        [""],
        ["https://en.wikipedia.org/wiki/University_of_the_Philippines_Diliman"],
      ]);
    }
    if (url === "https://en.wikipedia.org/api/rest_v1/page/summary/University%20of%20the%20Philippines%20Diliman") {
      return jsonResponse({
        title: "University of the Philippines Diliman",
        extract: "The University of the Philippines Diliman is a public research university in Quezon City, Philippines.",
        content_urls: {
          desktop: {
            page: "https://en.wikipedia.org/wiki/University_of_the_Philippines_Diliman",
          },
        },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "compound_tools");
  assert.deepEqual(calls, [
    "https://uat.mundusx.ai/v1/jobs",
    "https://wttr.in/Berlin?format=j1",
    "https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=University%20of%20the%20Philippines%20Diliman",
    "https://en.wikipedia.org/api/rest_v1/page/summary/University%20of%20the%20Philippines%20Diliman",
  ]);
  assert.match(result.output, /## Weather for Berlin, Germany/);
  assert.match(result.output, /Sunny, 20C\/68F/);
  assert.match(result.output, /## University of the Philippines Diliman/);
  assert.match(result.output, /public research university in Quezon City/i);
  assert.match(result.output, /## MundusX/);
  assert.match(result.output, /decentralized AI compute/i);
  assert.equal(result.response.type, "compound_tool_result");
  assert.deepEqual(result.response.sections.map((section) => section.type), [
    "weather",
    "factual_summary",
    "mundusx_knowledge",
  ]);
});

test("uses the LLM planner before tools for multi-intent prompts", async () => {
  const calls = [];
  const prompt =
    "What is the weather in Berlin, also tell me details of University of the Philippines Diliman finally what is MundusX?";
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      assert.match(body.system_prompt, /You are the MundusX tool planner/);
      assert.equal(body.execution_mode, "single");
      assert.equal(body.max_tokens, 384);
      assert.equal(body.temperature, 0);
      return jsonResponse({
        job_id: "planner-1",
        status: "completed",
        job: {
          job_id: "planner-1",
          status: "completed",
          output: JSON.stringify({
            intents: [
              { type: "weather", location: "Berlin" },
              { type: "factual", topic: "University of the Philippines Diliman" },
              { type: "mundusx_knowledge", topic: "overview" },
            ],
          }),
        },
      });
    }
    if (url === "https://wttr.in/Berlin?format=j1") {
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Berlin" }],
            region: [{ value: "Berlin" }],
            country: [{ value: "Germany" }],
          },
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Sunny" }],
            temp_C: "20",
            temp_F: "68",
            FeelsLikeC: "20",
            FeelsLikeF: "68",
            humidity: "56",
            windspeedKmph: "19",
          },
        ],
      });
    }
    if (url.includes("opensearch")) {
      assert.match(url, /search=University%20of%20the%20Philippines%20Diliman/);
      return jsonResponse([
        "University of the Philippines Diliman",
        ["University of the Philippines Diliman"],
        [""],
        ["https://en.wikipedia.org/wiki/University_of_the_Philippines_Diliman"],
      ]);
    }
    if (url === "https://en.wikipedia.org/api/rest_v1/page/summary/University%20of%20the%20Philippines%20Diliman") {
      return jsonResponse({
        title: "University of the Philippines Diliman",
        extract: "The University of the Philippines Diliman is a public research university in Quezon City, Philippines.",
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.tool, "compound_tools");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://uat.mundusx.ai/v1/jobs",
    "https://wttr.in/Berlin?format=j1",
    "https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=University%20of%20the%20Philippines%20Diliman",
    "https://en.wikipedia.org/api/rest_v1/page/summary/University%20of%20the%20Philippines%20Diliman",
  ]);
  assert.deepEqual(result.response.sections.map((section) => section.type), [
    "weather",
    "factual_summary",
    "mundusx_knowledge",
  ]);
});

test("routes planned LLM sections back through control-plane jobs", async () => {
  const calls = [];
  const prompt = "What is the weather in Berlin and write one short launch tagline for MundusX.";
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      if (/You are the MundusX tool planner/.test(body.system_prompt)) {
        assert.equal(body.execution_mode, "single");
        return jsonResponse({
          job_id: "planner-llm-1",
          status: "completed",
          job: {
            job_id: "planner-llm-1",
            status: "completed",
            output: JSON.stringify({
              intents: [
                { type: "weather", location: "Berlin" },
                {
                  type: "llm_auto",
                  title: "Launch tagline",
                  prompt: "Write one short launch tagline for MundusX.",
                },
              ],
            }),
          },
        });
      }
      assert.equal(body.prompt, "Write one short launch tagline for MundusX.");
      assert.equal(body.execution_mode, "auto");
      assert.doesNotMatch(body.system_prompt, /You are the MundusX tool planner/);
      return jsonResponse({
        job_id: "tagline-1",
        status: "completed",
        job: {
          job_id: "tagline-1",
          status: "completed",
          model: "Qwen/Test",
          execution_mode: "auto",
          output: "MundusX turns idle compute into shared AI power.",
        },
      });
    }
    if (url === "https://wttr.in/Berlin?format=j1") {
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Berlin" }],
            region: [{ value: "Berlin" }],
            country: [{ value: "Germany" }],
          },
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Sunny" }],
            temp_C: "20",
            temp_F: "68",
            FeelsLikeC: "20",
            FeelsLikeF: "68",
            humidity: "56",
            windspeedKmph: "19",
          },
        ],
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.tool, "compound_tools");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://uat.mundusx.ai/v1/jobs",
    "https://wttr.in/Berlin?format=j1",
    "https://uat.mundusx.ai/v1/jobs",
  ]);
  assert.match(result.output, /## Weather for Berlin, Germany/);
  assert.match(result.output, /## Launch tagline/);
  assert.match(result.output, /idle compute into shared AI power/);
  assert.deepEqual(result.response.sections.map((section) => section.type), ["weather", "llm"]);
  assert.equal(result.response.sections[1].response.job_id, "tagline-1");
  assert.equal(result.response.sections[1].response.execution_mode, "auto");
});

test("honors planner-requested decomposed LLM sections", async () => {
  const calls = [];
  const prompt = "What is the weather in Berlin, also give me a detailed launch roadmap for MundusX chat.";
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      if (/You are the MundusX tool planner/.test(body.system_prompt)) {
        return jsonResponse({
          job_id: "planner-decompose-1",
          status: "completed",
          job: {
            job_id: "planner-decompose-1",
            status: "completed",
            output: JSON.stringify({
              intents: [
                { type: "weather", location: "Berlin" },
                {
                  type: "llm_decompose",
                  title: "Launch roadmap",
                  prompt: "Give a detailed launch roadmap for MundusX chat.",
                },
              ],
            }),
          },
        });
      }
      assert.equal(body.prompt, "Give a detailed launch roadmap for MundusX chat.");
      assert.equal(body.execution_mode, "decompose");
      return jsonResponse({
        job_id: "plan-1",
        status: "completed",
        job: {
          job_id: "plan-1",
          status: "completed",
          model: "Qwen/Test",
          execution_mode: "decompose",
          output: "Plan section output.",
        },
      });
    }
    if (url === "https://wttr.in/Berlin?format=j1") {
      return jsonResponse({
        nearest_area: [{ areaName: [{ value: "Berlin" }], region: [{ value: "Berlin" }], country: [{ value: "Germany" }] }],
        current_condition: [
          {
            weatherDesc: [{ value: "Sunny" }],
            temp_C: "20",
            temp_F: "68",
            FeelsLikeC: "20",
            FeelsLikeF: "68",
            humidity: "56",
            windspeedKmph: "19",
          },
        ],
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://uat.mundusx.ai/v1/jobs",
    "https://wttr.in/Berlin?format=j1",
    "https://uat.mundusx.ai/v1/jobs",
  ]);
  assert.equal(result.response.sections[1].response.execution_mode, "decompose");
  assert.match(result.output, /Plan section output/);
});

test("cleans planned weather locations and routes planned math in compound prompts", async () => {
  const calls = [];
  const prompt = "What is mundusx? What is the weather in Manila? Subtract 3(x2+1)2 from 6x3 -9x2 -13x -4";
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      assert.match(body.system_prompt, /You are the MundusX tool planner/);
      return jsonResponse({
        job_id: "planner-math-1",
        status: "completed",
        job: {
          job_id: "planner-math-1",
          status: "completed",
          output: JSON.stringify({
            intents: [
              { type: "mundusx_knowledge", topic: "overview" },
              { type: "weather", location: "Manila? Subtract 3(x2+1)2 from 6x3 -9x2 -13x -4" },
              { type: "math", prompt: "Subtract 3(x2+1)2 from 6x3 -9x2 -13x -4" },
            ],
          }),
        },
      });
    }
    if (url === "https://wttr.in/Manila?format=j1") {
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Manila" }],
            region: [{ value: "Metro Manila" }],
            country: [{ value: "Philippines" }],
          },
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Partly cloudy" }],
            temp_C: "30",
            temp_F: "86",
            FeelsLikeC: "34",
            FeelsLikeF: "93",
            humidity: "70",
            windspeedKmph: "12",
          },
        ],
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.tool, "compound_tools");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://uat.mundusx.ai/v1/jobs",
    "https://wttr.in/Manila?format=j1",
  ]);
  assert.deepEqual(result.response.sections.map((section) => section.type), [
    "mundusx_knowledge",
    "weather",
    "math",
  ]);
  assert.match(result.output, /## MundusX/);
  assert.match(result.output, /## Weather for Manila, Metro Manila, Philippines/);
  assert.match(result.output, /## Polynomial subtraction/);
  assert.match(result.output, /Answer: -3x\^4 \+ 6x\^3 - 15x\^2 - 13x - 7/);
});

test("falls back to normal chat when the LLM planner returns no usable plan and no safe direct tools", async () => {
  const calls = [];
  const prompt = "Tell me something interesting about math and explain why learning is useful?";
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      if (/You are the MundusX tool planner/.test(body.system_prompt ?? "")) {
        return plannerJobResponse([], "planner-empty");
      }
      return jsonResponse({
        job_id: "normal-after-empty-planner",
        status: "completed",
        job: {
          job_id: "normal-after-empty-planner",
          status: "completed",
          output: "Routed through the control plane after planner returned no chunks.",
          model: "Qwen/Qwen2.5-1.5B-Instruct",
          execution_mode: "auto",
        },
      });
    }
    throw new Error(`unexpected direct tool call ${url}`);
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.tool, undefined);
  assert.equal(result.output, "Routed through the control plane after planner returned no chunks.");
  assert.equal(calls.filter((call) => call.url === "https://uat.mundusx.ai/v1/jobs").length, 2);
  assert.deepEqual(
    calls.filter((call) => call.url !== "https://uat.mundusx.ai/v1/jobs").map((call) => call.url),
    ["https://uat.mundusx.ai/v1/nodes?page=1&page_size=25"],
  );
});

test("falls back to deterministic compound tools when planner misses obvious direct intents", async () => {
  const calls = [];
  const prompt = "what's the weather in Stuttgart Germany? and Introduced yourself? Who is Donald Trump?";
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      assert.match(body.system_prompt, /You are the MundusX tool planner/);
      return plannerJobResponse([], "planner-empty");
    }
    if (url === "https://wttr.in/Stuttgart%20Germany?format=j1") {
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Stuttgart" }],
            region: [{ value: "Baden-Wurttemberg" }],
            country: [{ value: "Germany" }],
          },
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Cloudy" }],
            temp_C: "19",
            temp_F: "66",
            FeelsLikeC: "19",
            FeelsLikeF: "66",
            humidity: "55",
            windspeedKmph: "12",
          },
        ],
      });
    }
    if (url.includes("opensearch")) {
      assert.match(url, /search=Donald%20Trump/);
      return jsonResponse(["Donald Trump", ["Donald Trump"], [""], ["https://en.wikipedia.org/wiki/Donald_Trump"]]);
    }
    if (url === "https://en.wikipedia.org/api/rest_v1/page/summary/Donald%20Trump") {
      return jsonResponse({
        title: "Donald Trump",
        extract: "Donald Trump is an American politician, media personality, and businessman.",
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Donald_Trump" } },
      });
    }
    throw new Error(`unexpected call ${url}`);
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.tool, "compound_tools");
  assert.deepEqual(result.response.sections.map((section) => section.type), [
    "weather",
    "assistant_identity",
    "factual_summary",
  ]);
  assert.match(result.output, /## Weather for Stuttgart, Baden-Wurttemberg, Germany/);
  assert.match(result.output, /Cloudy, 19C\/66F/);
  assert.match(result.output, /## Atlas/);
  assert.match(result.output, /I'm Atlas/);
  assert.match(result.output, /## Donald Trump/);
  assert.match(result.output, /American politician/);
  assert.doesNotMatch(result.output, /generated unrelated questions/i);
});

test("allows fallback answers without verifier rejection", async () => {
  const prompt = "Tell me something interesting about math and explain why learning is useful?";
  const fetchImpl = async (url, init = {}) => {
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      if (/You are the MundusX tool planner/.test(body.system_prompt ?? "")) {
        return plannerJobResponse([], "planner-empty");
      }
      return jsonResponse({
        job_id: "normal-drift",
        status: "completed",
        job: {
          job_id: "normal-drift",
          status: "completed",
          output: [
            "What is the sum of the first 100 odd numbers?",
            "What is the area of a circle with a radius of 5 units?",
            "What is the area of a square with a side length of 4 units?",
            "What is the volume of a cube with a side length of 3 units?",
            "What is the area of a triangle with base 6 units and height 4 units?",
            "What is the area of a rectangle with length 8 units and width 3 units?",
          ].join(" "),
          model: "Qwen/Qwen2.5-1.5B-Instruct",
          execution_mode: "auto",
        },
      });
    }
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ nodes: [] });
    }
    throw new Error(`unexpected call ${url}`);
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.match(result.output, /sum of the first 100 odd numbers/);
  assert.deepEqual(result.quality_flags, []);
});

test("allows asynchronously completed answers without verifier rejection", async () => {
  const prompt = "Tell me something interesting about math and explain why learning is useful?";
  const fetchImpl = async (url, init = {}) => {
    if (url === "https://uat.mundusx.ai/v1/jobs" && init.method === "POST") {
      const body = JSON.parse(init.body);
      if (/You are the MundusX tool planner/.test(body.system_prompt ?? "")) {
        return plannerJobResponse([], "planner-empty");
      }
      return jsonResponse({
        job_id: "normal-drift-later",
        status: "queued",
        job: {
          job_id: "normal-drift-later",
          status: "queued",
          model: "Qwen/Qwen2.5-1.5B-Instruct",
          execution_mode: "auto",
        },
      });
    }
    if (url === "https://uat.mundusx.ai/v1/jobs/normal-drift-later") {
      return jsonResponse({
        job: {
          job_id: "normal-drift-later",
          status: "completed",
          output: [
            "What is the sum of the first 100 odd numbers?",
            "What is the area of a circle with a radius of 5 units?",
            "What is the area of a square with a side length of 4 units?",
            "What is the volume of a cube with a side length of 3 units?",
            "What is the area of a triangle with base 6 units and height 4 units?",
            "What is the area of a rectangle with length 8 units and width 3 units?",
          ].join(" "),
        },
      });
    }
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ nodes: [] });
    }
    throw new Error(`unexpected call ${url}`);
  };

  const submitted = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  assert.equal(submitted.status, "queued");

  const polled = await pollChatJob(
    "normal-drift-later",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(polled.status, "completed");
  assert.match(polled.output, /sum of the first 100 odd numbers/);
  assert.deepEqual(polled.quality_flags, []);
});

test("answers compound weather and name prompts without polluting the weather location", async () => {
  const calls = [];
  const prompt = "Can you tell me the weather in stuttgart germany today, and please tell me your name?";
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      assert.match(body.system_prompt, /You are the MundusX tool planner/);
      return plannerJobResponse([
        { type: "weather", location: "stuttgart germany" },
        { type: "assistant_identity", topic: "name" },
      ], "planner-weather-name");
    }
    assert.equal(url, "https://wttr.in/stuttgart%20germany?format=j1");
    return jsonResponse({
      nearest_area: [
        {
          areaName: [{ value: "Stuttgart" }],
          region: [{ value: "Baden-Wurttemberg" }],
          country: [{ value: "Germany" }],
        },
      ],
      current_condition: [
        {
          weatherDesc: [{ value: "Cloudy" }],
          temp_C: "18",
          temp_F: "64",
          FeelsLikeC: "18",
          FeelsLikeF: "64",
          humidity: "70",
          windspeedKmph: "11",
        },
      ],
    });
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.tool, "compound_tools");
  assert.deepEqual(calls, [
    "https://uat.mundusx.ai/v1/jobs",
    "https://wttr.in/stuttgart%20germany?format=j1",
  ]);
  assert.match(result.output, /## Weather for Stuttgart, .*Germany/);
  assert.match(result.output, /Cloudy, 18C\/64F/);
  assert.match(result.output, /## Atlas/);
  assert.match(result.output, /My name is Atlas\./);
  assert.deepEqual(result.response.sections.map((section) => section.type), [
    "weather",
    "assistant_identity",
  ]);
});

test("answers multiple assistant identity intents in one compound prompt", async () => {
  const calls = [];
  const prompt = "Please tell me your name And tell me the weather in Stuttgart today And Who created you";
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      assert.match(body.system_prompt, /You are the MundusX tool planner/);
      return plannerJobResponse([
        { type: "assistant_identity", topic: "name" },
        { type: "weather", location: "Stuttgart" },
        { type: "assistant_identity", topic: "creator" },
      ], "planner-identity-weather-creator");
    }
    assert.equal(url, "https://wttr.in/Stuttgart?format=j1");
    return jsonResponse({
      nearest_area: [
        {
          areaName: [{ value: "Stuttgart" }],
          region: [{ value: "Baden-Wurttemberg" }],
          country: [{ value: "Germany" }],
        },
      ],
      current_condition: [
        {
          weatherDesc: [{ value: "Rain Shower" }],
          temp_C: "27",
          temp_F: "81",
          FeelsLikeC: "27",
          FeelsLikeF: "81",
          humidity: "34",
          windspeedKmph: "21",
        },
      ],
    });
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.tool, "compound_tools");
  assert.deepEqual(calls, [
    "https://uat.mundusx.ai/v1/jobs",
    "https://wttr.in/Stuttgart?format=j1",
  ]);
  assert.deepEqual(result.response.sections.map((section) => section.type), [
    "assistant_identity",
    "weather",
    "assistant_identity",
  ]);
  assert.deepEqual(result.response.sections.map((section) => section.response.topic ?? section.type), [
    "name",
    "weather",
    "creator",
  ]);
  assert.match(result.output, /## Atlas\nMy name is Atlas\./);
  assert.match(result.output, /## Weather for Stuttgart, .*Germany/);
  assert.match(result.output, /Rain Shower, 27C\/81F/);
  assert.match(result.output, /created by the MundusX open-source team/i);
});

test("caps and preserves order for larger compound direct-tool prompts", async () => {
  const calls = [];
  const prompt =
    "Tell me your name, weather in Berlin, who is David Batalla, weather in Stuttgart, who created you, and your mission";
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      const body = JSON.parse(init.body);
      assert.match(body.system_prompt, /You are the MundusX tool planner/);
      return plannerJobResponse([
        { type: "assistant_identity", topic: "name" },
        { type: "weather", location: "Berlin" },
        { type: "factual", topic: "David Batalla" },
        { type: "weather", location: "Stuttgart" },
        { type: "assistant_identity", topic: "creator" },
        { type: "assistant_identity", topic: "mission" },
      ], "planner-six-intents");
    }
    if (url === "https://wttr.in/Berlin?format=j1") {
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Berlin" }],
            region: [{ value: "Berlin" }],
            country: [{ value: "Germany" }],
          },
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Clear" }],
            temp_C: "20",
            temp_F: "68",
            FeelsLikeC: "20",
            FeelsLikeF: "68",
            humidity: "45",
            windspeedKmph: "9",
          },
        ],
      });
    }
    if (url === "https://wttr.in/Stuttgart?format=j1") {
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Stuttgart" }],
            region: [{ value: "Baden-Wurttemberg" }],
            country: [{ value: "Germany" }],
          },
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Rain Shower" }],
            temp_C: "27",
            temp_F: "81",
            FeelsLikeC: "27",
            FeelsLikeF: "81",
            humidity: "34",
            windspeedKmph: "21",
          },
        ],
      });
    }
    if (url.includes("opensearch")) {
      assert.match(url, /search=David%20Batalla/);
      return jsonResponse(["David Batalla", [], [], []]);
    }
    if (url === "https://en.wikipedia.org/api/rest_v1/page/summary/David%20Batalla") {
      return jsonResponse({ title: "Not found" }, false, 404);
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.tool, "compound_tools");
  assert.equal(result.response.sections.length, 6);
  assert.deepEqual(result.response.sections.map((section) => section.type), [
    "assistant_identity",
    "weather",
    "factual_summary",
    "weather",
    "assistant_identity",
    "assistant_identity",
  ]);
  assert.deepEqual(result.response.sections.map((section) => section.response.topic ?? section.type), [
    "name",
    "weather",
    "factual_summary",
    "weather",
    "creator",
    "mission",
  ]);
  assert.match(result.output, /## Atlas\nMy name is Atlas\./);
  assert.match(result.output, /## Weather for Berlin, Germany/);
  assert.match(result.output, /## David Batalla/);
  assert.match(result.output, /## Weather for Stuttgart, Baden-Wurttemberg, Germany/);
  assert.match(result.output, /created by the MundusX open-source team/i);
  assert.match(result.output, /My mission is to help people understand/i);
});

test("routes malformed voice who-is prompts to cautious factual fallback instead of the LLM", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("opensearch")) {
      assert.match(url, /search=David%20Battalia/);
      return jsonResponse(["David Battalia", ["David Batalla"], [""], ["https://en.wikipedia.org/wiki/David_Batalla"]]);
    }
    if (url === "https://en.wikipedia.org/api/rest_v1/page/summary/David%20Batalla") {
      return jsonResponse({ title: "Not found" }, false, 404);
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await submitChatJob(
    { message: "Who i David Battalia" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "factual_summary");
  assert.equal(result.response.verified, false);
  assert.match(result.response.text, /do not have enough verified public information/i);
  assert.match(result.output, /David Batalla/);
  assert.match(result.output, /do not have enough verified public information/i);
  assert.doesNotMatch(result.output, /role in the MundusX project/i);
  assert.doesNotMatch(result.output, /co-founder/i);
  assert.deepEqual(calls, [
    "https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=David%20Battalia",
    "https://en.wikipedia.org/api/rest_v1/page/summary/David%20Batalla",
  ]);
});

test("routes unknown who-is prompts to cautious factual fallback instead of the LLM", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("opensearch")) {
      assert.match(url, /search=Lichard%20Baliuag/);
      return jsonResponse(["Lichard Baliuag", [], [], []]);
    }
    if (url === "https://en.wikipedia.org/api/rest_v1/page/summary/Lichard%20Baliuag") {
      return jsonResponse({ error: "not found" }, { status: 404 });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await submitChatJob(
    { message: "Who is Lichard Baliuag?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "factual_summary");
  assert.equal(result.response.verified, false);
  assert.match(result.response.text, /do not have enough verified public information about Lichard Baliuag/i);
  assert.match(result.output, /do not have enough verified public information about Lichard Baliuag/i);
  assert.doesNotMatch(result.output, /role in the MundusX/i);
  assert.deepEqual(calls, [
    "https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=Lichard%20Baliuag",
    "https://en.wikipedia.org/api/rest_v1/page/summary/Lichard%20Baliuag",
  ]);
});

test("routes factual history questions to a grounded summary source", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("opensearch")) {
      assert.match(url, /search=BMW/);
      return jsonResponse(["BMW", ["BMW"], [""], ["https://en.wikipedia.org/wiki/BMW"]]);
    }
    assert.equal(url, "https://en.wikipedia.org/api/rest_v1/page/summary/BMW");
    return jsonResponse({
      title: "BMW",
      description: "German multinational manufacturer of luxury vehicles and motorcycles",
      extract:
        "Bayerische Motoren Werke AG, commonly abbreviated to BMW, is a German multinational manufacturer of luxury vehicles and motorcycles headquartered in Munich, Bavaria, Germany. The company was founded in 1916 as a manufacturer of aircraft engines.",
    });
  };

  const result = await submitChatJob(
    { message: "Give me a detailed history of BMW from its origins to today." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls.length, 2);
  assert.equal(result.status, "completed");
  assert.equal(result.model, "wikipedia-summary");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "factual_summary");
  assert.equal(result.assigned_node_id, "facts-tool");
  assert.match(result.response.text, /Bayerische Motoren Werke AG/);
  assert.match(result.output, /Bayerische Motoren Werke AG/);
  assert.match(result.output, /founded in 1916/);
});

test("resolves the real Wikipedia title via search before fetching a summary", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("opensearch")) {
      assert.match(url, /search=sara%20duterte/);
      return jsonResponse(["sara duterte", ["Sara Duterte"], [""], ["https://en.wikipedia.org/wiki/Sara_Duterte"]]);
    }
    assert.equal(url, "https://en.wikipedia.org/api/rest_v1/page/summary/Sara%20Duterte");
    return jsonResponse({
      title: "Sara Duterte",
      description: "Vice President of the Philippines",
      extract: "Sara Zimmerman Duterte-Carpio is a Filipino lawyer and politician.",
    });
  };

  const result = await submitChatJob(
    { message: "who is sara duterte from ph?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls.length, 2);
  assert.equal(result.status, "completed");
  assert.equal(result.tool, "factual_summary");
  assert.match(result.output, /Sara Zimmerman Duterte-Carpio/);
});

test("routes free-form tool-mode requests for a person to a grounded summary", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("opensearch")) {
      assert.match(url, /search=Elon%20Musk/);
      return jsonResponse(["Elon Musk", ["Elon Musk"], [""], ["https://en.wikipedia.org/wiki/Elon_Musk"]]);
    }
    assert.equal(url, "https://en.wikipedia.org/api/rest_v1/page/summary/Elon%20Musk");
    return jsonResponse({
      title: "Elon Musk",
      description: "Businessman and public official",
      extract: "Elon Reeve Musk is a businessman.",
    });
  };

  const result = await submitChatJob(
    {
      message: "Can you provide more truthful information about Elon Musk with reference in the internet?",
      toolMode: true,
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls.length, 2);
  assert.equal(result.status, "completed");
  assert.equal(result.tool, "factual_summary");
  assert.match(result.output, /Elon Reeve Musk/);
});

test("declines a fuzzy Wikipedia match and falls through to a normal LLM job instead of presenting the wrong subject as fact", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("opensearch")) {
      return jsonResponse(["Dave Batalla", ["Dave Tallant"], [""], ["https://en.wikipedia.org/wiki/Dave_Tallant"]]);
    }
    if (url.includes("/page/summary/")) {
      return jsonResponse({ error: "not found" }, { status: 404 });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    return jsonResponse({
      job_id: "job-fallback",
      job: {
        job_id: "job-fallback",
        status: "queued",
        execution_mode: "auto",
        graph: { nodes: [] },
      },
    });
  };

  const result = await submitChatJob(
    {
      message: "Can you provide more truthful information about Dave Batalla with reference in the internet?",
      toolMode: true,
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.doesNotMatch(JSON.stringify(result), /Tallant/);
  assert.equal(result.job_id, "job-fallback");
  assert.equal(result.status, "queued");
});

test("extracts general lookup topics from free-form tool-mode phrasing", () => {
  assert.equal(
    extractGeneralLookupTopic(
      "Can you provide more truthful information about Dave Batalla with reference in the internet?",
    ),
    "Dave Batalla",
  );
  assert.equal(extractGeneralLookupTopic("Can you give me accurate details about Elon Musk?"), "Elon Musk");
  assert.equal(
    extractGeneralLookupTopic("Could you please look up information about the Eiffel Tower"),
    "the Eiffel Tower",
  );
  assert.equal(extractGeneralLookupTopic("Write code for a login form"), null);
  assert.equal(extractGeneralLookupTopic("Can you help me plan a trip"), null);
});

test("gates web search on factual signals, not conversation or creative requests", () => {
  assert.equal(needsGrounding("What year did the Berlin Wall fall?"), true);
  assert.equal(needsGrounding("How many people live in Tokyo?"), true);
  assert.equal(needsGrounding("What is the current price of Bitcoin?"), true);
  assert.equal(needsGrounding("Who won the 2022 World Cup?"), true);
  assert.equal(needsGrounding("hi"), false);
  assert.equal(needsGrounding("thanks!"), false);
  assert.equal(needsGrounding("Write me a poem about the ocean"), false);
  assert.equal(needsGrounding("What do you think about pineapple on pizza"), false);
});

test("routes tool-mode grounded requests through Brave Search and injects citable sources", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes("api.search.brave.com")) {
      assert.match(String(url), /q=What\+is\+Elon\+Musk/);
      return jsonResponse({
        web: {
          results: [
            { title: "Elon Musk net worth", url: "https://example.com/elon", description: "Elon Musk's net worth is estimated at $200 billion." },
          ],
        },
      });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    return jsonResponse({
      job_id: "job-grounded-1",
      job: {
        job_id: "job-grounded-1",
        status: "completed",
        output: "Elon Musk's net worth is about $200 billion [1].",
        execution_mode: "tool",
      },
    });
  };

  const result = await submitChatJob(
    { message: "What is Elon Musk net worth right now?", toolMode: true },
    configFromEnv({
      MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai",
      MUNDUSX_WEB_SEARCH_API_KEY: "test-key",
    }),
    fetchImpl,
  );

  assert.equal(result.tool, "web_search");
  assert.equal(result.status, "completed");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, "https://example.com/elon");
  assert.match(result.output, /\$200 billion/);

  const jobsCall = calls.find((url) => url === "https://uat.mundusx.ai/v1/jobs");
  assert.ok(jobsCall);
});

test("declines web search without an API key and falls through to a normal job", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes("api.search.brave.com")) {
      throw new Error("should not call Brave Search without an API key");
    }
    if (String(url).includes("wikipedia.org") || String(url).includes("opensearch")) {
      return jsonResponse({ error: "not found" }, { status: 404 });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    return jsonResponse({
      job_id: "job-no-key",
      job: { job_id: "job-no-key", status: "queued", execution_mode: "auto", graph: { nodes: [] } },
    });
  };

  const result = await submitChatJob(
    { message: "What is the current population of Japan?", toolMode: true },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.ok(!calls.some((url) => String(url).includes("api.search.brave.com")));
  assert.equal(result.job_id, "job-no-key");
});

test("does not attempt web search when tool mode is off", async () => {
  const result = await submitChatJob(
    { message: "What year did the Berlin Wall fall?" },
    configFromEnv({
      MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai",
      MUNDUSX_WEB_SEARCH_API_KEY: "test-key",
    }),
    async (url) => {
      if (String(url).includes("api.search.brave.com")) {
        throw new Error("should not call web search when tool mode is off");
      }
      assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
      return jsonResponse({
        job_id: "job-plain",
        job: { job_id: "job-plain", status: "queued", execution_mode: "auto", graph: { nodes: [] } },
      });
    },
  );

  assert.equal(result.job_id, "job-plain");
});

test("routes current president questions to Wikidata instead of the LLM", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === "https://www.wikidata.org/wiki/Special:EntityData/Q30.json") {
      return jsonResponse({
        entities: {
          Q30: {
            claims: {
              P6: [
                {
                  rank: "preferred",
                  mainsnak: { datavalue: { value: { id: "Q22686" } } },
                },
              ],
            },
          },
        },
      });
    }
    assert.equal(url, "https://www.wikidata.org/wiki/Special:EntityData/Q22686.json");
    return jsonResponse({
      entities: {
        Q22686: {
          labels: { mul: { value: "Donald Trump" } },
        },
      },
    });
  };

  const result = await submitChatJob(
    { message: "Who is the current president of USA today 2026?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.deepEqual(calls, [
    "https://www.wikidata.org/wiki/Special:EntityData/Q30.json",
    "https://www.wikidata.org/wiki/Special:EntityData/Q22686.json",
  ]);
  assert.equal(result.status, "completed");
  assert.equal(result.model, "wikidata");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "current_office_holder");
  assert.equal(result.assigned_node_id, "facts-tool");
  assert.match(result.output, /Current president of the United States: Donald Trump/);
});

test("falls back to MundusX jobs when factual summary lookup misses", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("opensearch")) {
      return jsonResponse(["UnknownThing", [], [], []]);
    }
    if (url.includes("/page/summary/")) {
      return jsonResponse({ error: "not found" }, { status: 404 });
    }
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [] });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    return jsonResponse({
      job_id: "job-fallback",
      job: {
        job_id: "job-fallback",
        status: "queued",
        execution_mode: "auto",
        graph: { nodes: [] },
      },
    });
  };

  const result = await submitChatJob(
    { message: "Give me a detailed history of UnknownThing." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls.filter((call) => call.url === "https://uat.mundusx.ai/v1/jobs").length, 1);
  assert.equal(result.job_id, "job-fallback");
  assert.equal(result.status, "queued");
});

test("falls back to a normal MundusX job when explicit tool mode has no matching tool", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [] });
    }
    calls.push(url);
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    return jsonResponse({
      job_id: "job-no-tool-match",
      job: {
        job_id: "job-no-tool-match",
        status: "queued",
        execution_mode: "auto",
        graph: { nodes: [] },
      },
    });
  };

  const result = await submitChatJob(
    { message: "latest NVIDIA driver for GTX 1650", toolMode: true },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls.length, 1);
  assert.equal(result.job_id, "job-no-tool-match");
  assert.equal(result.status, "queued");
});

test("accepts at-prefixed web search requests for direct tools", async () => {
  const calls = [];
  const result = await submitChatJob(
    { message: "@ weather in Manila", toolMode: true },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url) => {
      calls.push(url);
      assert.equal(url, "https://wttr.in/Manila?format=j1");
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Manila" }],
            region: [{ value: "National Capital Region" }],
            country: [{ value: "Philippines" }],
          },
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Partly cloudy" }],
            temp_C: "31",
            temp_F: "88",
            FeelsLikeC: "35",
            FeelsLikeF: "95",
            humidity: "70",
            windspeedKmph: "12",
          },
        ],
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.tool, "weather");
  assert.match(result.output, /Weather for Manila/);
});

test("returns immediate weather turns without polling the control plane", async () => {
  const result = await submitChatTurn(
    { message: "forecast for Cebu" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url) => {
      assert.equal(url, "https://wttr.in/Cebu?format=j1");
      return jsonResponse({
        nearest_area: [{ areaName: [{ value: "Cebu" }], country: [{ value: "Philippines" }] }],
        current_condition: [
          {
            weatherDesc: [{ value: "Sunny" }],
            temp_C: "30",
            temp_F: "86",
            FeelsLikeC: "34",
            FeelsLikeF: "93",
            humidity: "65",
            windspeedKmph: "9",
          },
        ],
      });
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.progress.strategy, "weather_tool");
});

test("adapts a Hermes OpenAI weather request to an immediate Chat-U tool response", async () => {
  const result = await submitOpenAiChatCompletion(
    {
      model: "mundusx-agnostic",
      messages: [{ role: "user", content: "What is the weather in Warsaw?" }],
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url) => {
      assert.equal(url, "https://wttr.in/Warsaw?format=j1");
      return jsonResponse({
        nearest_area: [{ areaName: [{ value: "Warsaw" }], country: [{ value: "Poland" }] }],
        current_condition: [{
          weatherDesc: [{ value: "Sunny" }],
          temp_C: "24",
          temp_F: "75",
          FeelsLikeC: "23",
          FeelsLikeF: "73",
          humidity: "40",
          windspeedKmph: "8",
        }],
      });
    },
  );

  assert.equal(result.object, "chat.completion");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.match(result.choices[0].message.content, /Weather for Warsaw, Poland/);
  assert.equal(result.model, "mundusx-agnostic");
  assert.equal(result.mundusx.tool, "weather");
  assert.equal("assigned_node_id" in result.mundusx, false);
});

test("routes natural Stuttgart tomorrow phrasing to the forecast day", async () => {
  const result = await submitOpenAiChatCompletion(
    {
      model: "mundusx-agnostic",
      messages: [{ role: "user", content: "Weather is stuttgart tomorrow?" }],
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url) => {
      assert.equal(url, "https://wttr.in/stuttgart?format=j1");
      return jsonResponse({
        nearest_area: [{
          areaName: [{ value: "Stuttgart" }],
          region: [{ value: "Baden-Wurttemberg" }],
          country: [{ value: "Germany" }],
        }],
        weather: [
          { date: "2026-08-13" },
          {
            date: "2026-08-14",
            maxtempC: "27",
            maxtempF: "81",
            mintempC: "16",
            mintempF: "61",
            hourly: [{ time: "1200", weatherDesc: [{ value: "Partly cloudy" }], chanceofrain: "20" }],
          },
        ],
      });
    },
  );

  assert.equal(result.mundusx.tool, "weather");
  assert.match(result.choices[0].message.content, /Weather forecast for Stuttgart, Baden-Wurttemberg, Germany tomorrow/);
  assert.match(result.choices[0].message.content, /high 27C\/81F, low 16C\/61F, chance of rain 20%/);
});

test("asks for a location instead of misrouting a locationless weather request", async () => {
  const result = await submitOpenAiChatCompletion(
    {
      model: "mundusx-agnostic",
      messages: [{ role: "user", content: "How is the weather today?" }],
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      throw new Error("location clarification must not call an upstream service");
    },
  );

  assert.equal(result.mundusx.tool, "weather_clarification");
  assert.equal(result.choices[0].message.content, "Which city or location would you like the weather for?");
});

test("adapts Hermes message history into Chat-U model context", async () => {
  let submittedJob = null;
  const result = await submitOpenAiChatCompletion(
    {
      messages: [
        { role: "system", content: "Keep answers concise." },
        { role: "user", content: "My preferred language is German." },
        { role: "assistant", content: "Understood." },
        { role: "user", content: "Say hello." },
      ],
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url, init = {}) => {
      if (url.endsWith("/v1/nodes?page=1&page_size=25")) {
        return jsonResponse({ nodes: [] });
      }
      if (url.endsWith("/v1/jobs") && init.method === "POST") {
        submittedJob = JSON.parse(init.body);
        return jsonResponse({ job_id: "job-hermes", job: { job_id: "job-hermes", status: "queued" } }, true, 202);
      }
      if (url.endsWith("/v1/jobs/job-hermes")) {
        return jsonResponse({
          job: {
            job_id: "job-hermes",
            status: "completed",
            model: "Qwen/Test",
            output: "Hallo!",
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  );

  assert.match(submittedJob.system_prompt, /System: Keep answers concise\./);
  assert.match(submittedJob.system_prompt, /User: My preferred language is German\./);
  assert.match(submittedJob.system_prompt, /Assistant: Understood\./);
  assert.equal(result.choices[0].message.content, "Hallo!");
  assert.equal(result.model, "mundusx-agnostic");
  assert.equal(result.mundusx.job_id, "job-hermes");
  assert.equal("assigned_node_id" in result.mundusx, false);
});

test("isolates a focused quoted request from stale OpenWebUI conversation history", async () => {
  let submittedJob = null;
  const quotedRequest = [
    "> Donald Trump: President of the United States (2017–2021; since 2025). Donald John Trump is an American politician and businessman.",
    "",
    "Explain",
  ].join("\n");
  const result = await submitOpenAiChatCompletion(
    {
      tool_mode: false,
      messages: [
        { role: "user", content: "Create a Java Fibonacci program." },
        { role: "assistant", content: "```java\npublic class FibonacciProgram {}\n```" },
        { role: "user", content: "Who is Donald Trump?" },
        { role: "assistant", content: "Donald Trump is the current US president." },
        { role: "user", content: quotedRequest },
      ],
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url, init = {}) => {
      if (url.endsWith("/v1/nodes?page=1&page_size=25")) {
        return jsonResponse({ nodes: [] });
      }
      if (url.endsWith("/v1/jobs") && init.method === "POST") {
        submittedJob = JSON.parse(init.body);
        return jsonResponse({
          job_id: "job-quote-isolated",
          job: {
            job_id: "job-quote-isolated",
            status: "completed",
            output: "The quote identifies Donald Trump's two non-consecutive presidential terms.",
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  );

  assert.equal(isFocusedQuotedRequest(quotedRequest), true);
  assert.doesNotMatch(submittedJob.system_prompt, /Fibonacci|Prior conversation/i);
  assert.match(submittedJob.system_prompt, /quoted source.*complete referent/i);
  assert.match(submittedJob.prompt, /Donald Trump[\s\S]*Explain/);
  assert.match(result.choices[0].message.content, /two non-consecutive presidential terms/);
});

test("does not isolate an ordinary history-dependent explanation follow-up", () => {
  assert.equal(isFocusedQuotedRequest("Explain that"), false);
  assert.equal(isFocusedQuotedRequest("> Too short\n\nExplain"), false);
});

test("Open WebUI adapter exposes a discoverable model and buffered SSE completion", () => {
  assert.deepEqual(openAiModelsResponse(configFromEnv({})).data.map((model) => model.id), ["mundusx-agnostic"]);
  const body = openAiSseBody({
    id: "chatcmpl-test",
    created: 123,
    model: "mundusx-agnostic",
    choices: [{ message: { role: "assistant", content: "Validated answer" }, finish_reason: "stop" }],
  });
  assert.match(body, /"object":"chat\.completion\.chunk"/);
  assert.match(body, /"content":"Validated answer"/);
  assert.match(body, /"finish_reason":"stop"/);
  assert.match(body, /data: \[DONE\]/);
});

test("Open WebUI stream starts with a standard stable assistant identity chunk", () => {
  const frame = openAiSseStartFrame("chatcmpl-openwebui-stable", 123);
  const chunk = JSON.parse(frame.replace(/^data: /, "").trim());
  assert.equal(chunk.id, "chatcmpl-openwebui-stable");
  assert.equal(chunk.object, "chat.completion.chunk");
  assert.equal(chunk.created, 123);
  assert.equal(chunk.choices[0].delta.role, "assistant");
  assert.equal(chunk.choices[0].delta.content, "");
  assert.equal(chunk.choices[0].finish_reason, null);
});

test("hybrid streaming buffers structured requests and chunks ordinary prose", () => {
  assert.equal(requiresValidatedStreaming("Create a complete Java program"), true);
  assert.equal(requiresValidatedStreaming("Return this as JSON"), true);
  assert.equal(requiresValidatedStreaming("What do you think about learning?"), false);

  const completion = {
    id: "chatcmpl-hybrid",
    created: 123,
    choices: [{ message: { role: "assistant", content: "A ".repeat(140).trim() }, finish_reason: "stop" }],
  };
  const ordinary = openAiSseFrames(completion, { buffered: false });
  const structured = openAiSseFrames(completion, { buffered: true });
  assert.ok(ordinary.length > 2);
  assert.equal(structured.length, 2);
  assert.match(ordinary.at(-1), /"finish_reason":"stop"/);
});

test("validates requested JSON before a structured response can complete", () => {
  assert.equal(detectStructuredOutputQualityFlags('{"ok":true}', true).length, 0);
  assert.equal(detectStructuredOutputQualityFlags('```json\n{"ok":true}\n```', true).length, 0);
  assert.equal(detectStructuredOutputQualityFlags('{"ok":', true)[0].code, "invalid_structured_output");
  assert.equal(detectStructuredOutputQualityFlags("ordinary prose", false).length, 0);
});

test("OpenAI adapter preserves an upstream length finish reason", async () => {
  const result = await submitOpenAiChatCompletion(
    { messages: [{ role: "user", content: "Tell me a short story." }] },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url, init = {}) => {
      if (url.endsWith("/v1/nodes?page=1&page_size=25")) return jsonResponse({ nodes: [] });
      if (url.endsWith("/v1/jobs") && init.method === "POST") {
        return jsonResponse({
          job_id: "job-length",
          job: {
            job_id: "job-length",
            status: "completed",
            output: "[truncated: hit the generation limit] An intentionally partial story",
            max_tokens: 64,
            max_tokens_source: "explicit",
          },
        }, true, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  );
  assert.equal(result.choices[0].finish_reason, "length");
  assert.equal(result.choices[0].message.content, "An intentionally partial story");
});

test("submitChatTurn retries a worker-reported auto-budget truncation with more tokens", async () => {
  const submitted = [];
  const result = await submitChatTurn(
    {
      message: "Give me a detailed history of Tesla from its origins to today.",
      toolMode: false,
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url, init = {}) => {
      if (url.endsWith("/v1/nodes?page=1&page_size=25")) return jsonResponse({ items: [] });
      if (url.endsWith("/v1/jobs") && init.method === "POST") {
        const body = JSON.parse(init.body);
        submitted.push(body);
        const retry = submitted.length === 2;
        return jsonResponse({
          job_id: retry ? "job-history-retry" : "job-history-first",
          job: {
            job_id: retry ? "job-history-retry" : "job-history-first",
            status: "completed",
            output: retry
              ? "Tesla was founded in 2003 and developed through several major product and manufacturing eras."
              : "[truncated: hit the generation limit] Tesla was founded in 2003 and",
            max_tokens: body.max_tokens,
            max_tokens_source: body.max_tokens_source,
            execution_mode: "auto",
            graph: { nodes: [] },
          },
        }, true, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  );

  assert.equal(submitted.length, 2);
  assert.equal(submitted[0].max_tokens, 2048);
  assert.equal(submitted[1].max_tokens, 4096);
  assert.match(submitted[1].system_prompt, /internal validation retry/i);
  assert.equal(result.status, "completed");
  assert.doesNotMatch(result.output, /truncated: hit the generation limit/i);
});

test("OpenAI adapter correlates its stable id and OpenWebUI chat id", async () => {
  const jobBodies = [];
  const conversationWrites = [];
  const result = await submitOpenAiChatCompletion(
    {
      request_id: "chatcmpl-openwebui-correlation",
      chat_id: "openwebui-chat-42",
      messages: [{ role: "user", content: "Write one sentence." }],
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url, init = {}) => {
      if (url.includes("/v1/conversations/openwebui-chat-42/messages")) {
        if (init.method === "POST") {
          conversationWrites.push(JSON.parse(init.body));
          return jsonResponse({ stored: true });
        }
        return jsonResponse({ messages: [] });
      }
      if (url.endsWith("/v1/nodes?page=1&page_size=25")) return jsonResponse({ nodes: [] });
      if (url.endsWith("/v1/jobs") && init.method === "POST") {
        jobBodies.push(JSON.parse(init.body));
        return jsonResponse({
          job_id: "chatcmpl-openwebui-correlation",
          job: {
            job_id: "chatcmpl-openwebui-correlation",
            status: "completed",
            output: "A complete sentence.",
          },
        }, true, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  );

  assert.equal(result.id, "chatcmpl-openwebui-correlation");
  assert.equal(jobBodies[0].request_id, result.id);
  assert.deepEqual(conversationWrites.map((entry) => entry.role), ["user", "assistant"]);
});

test("generative Chat-U requests stream while deterministic and tool routes fall back", () => {
  assert.equal(canLiveStreamChatTurn({ message: "Explain distributed systems.", toolMode: false }), true);
  assert.equal(canLiveStreamChatTurn({ message: "Create a complete Java program", toolMode: false }), true);
  assert.equal(canLiveStreamChatTurn({ message: "Return a JSON schema for a customer record", toolMode: false }), true);
  assert.equal(canLiveStreamChatTurn({ message: "Weather in Warsaw?", toolMode: false }), false);
  assert.equal(canLiveStreamChatTurn({ message: "Who is Ada Lovelace?", toolMode: false }), false);
  assert.equal(canLiveStreamChatTurn({ message: "Latest NVIDIA news", toolMode: true }), false);
});

test("streaming relay exposes the first upstream delta before completion", async () => {
  const encoder = new TextEncoder();
  let releaseStream;
  const upstreamBody = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"id":"chatcmpl-live","choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n' +
        'data: {"id":"chatcmpl-live","choices":[{"delta":{"content":"Alpha "},"finish_reason":null}]}\n\n',
      ));
      releaseStream = () => {
        controller.enqueue(encoder.encode(
          'data: {"id":"chatcmpl-live","choices":[{"delta":{"content":"Beta"},"finish_reason":null}]}\n\n' +
          'data: {"id":"chatcmpl-live","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
        ));
        controller.close();
      };
    },
  });
  const events = [];
  const response = {
    writableEnded: false,
    writeHead: (status, headers) => events.push({ type: "headers", status, headers }),
    flushHeaders: () => events.push({ type: "flush" }),
    write: (value) => {
      events.push({ type: "write", value });
      return true;
    },
    end(value) {
      this.writableEnded = true;
      events.push({ type: "end", value });
    },
  };
  const streaming = relayControlPlaneOpenAiStream(
    response,
    { stream: true, messages: [{ role: "user", content: "Explain this." }] },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "X-MundusX-Stream-Mode": "live-delta" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[0].type, "headers");
  assert.equal(events[0].headers["X-MundusX-Stream-Mode"], "live-delta");
  assert.equal(events[0].headers["X-Accel-Buffering"], "no");
  assert.equal(events[1].type, "flush");
  assert.equal(events[2].type, "write");
  assert.match(events[2].value, /"content":"Alpha "/);
  assert.equal(response.writableEnded, false);
  releaseStream();
  const result = await streaming;
  assert.equal(result.content, "Alpha Beta");
  assert.equal(result.completionId, "chatcmpl-live");
  assert.equal(result.finishReason, "stop");
  assert.equal(events.at(-1).type, "end");
});

test("deterministic Chat-U requests return an explicit polling fallback without upstream work", async () => {
  const events = [];
  const response = {
    writeHead: (status, headers) => events.push({ status, headers }),
    end: (value) => events.push({ value }),
  };
  let fetchCalled = false;
  await streamChatTurn(
    response,
    { message: "Weather in Warsaw?", toolMode: false },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => {
      fetchCalled = true;
      throw new Error("unexpected fetch");
    },
  );
  assert.equal(fetchCalled, false);
  assert.equal(events[0].status, 409);
  assert.deepEqual(JSON.parse(events[1].value), { fallback: true, reason: "deterministic_or_tool_routed" });
});

test("live Chat-U stream preserves history and persists one user and assistant turn", async () => {
  const encoder = new TextEncoder();
  const writes = [];
  let upstreamRequest = null;
  const response = {
    writableEnded: false,
    writeHead: () => {},
    flushHeaders: () => {},
    write: () => true,
    end() { this.writableEnded = true; },
  };
  const fetchImpl = async (url, init = {}) => {
    if (url.includes("/v1/conversations/conversation-live/messages")) {
      writes.push(JSON.parse(init.body));
      return jsonResponse({ stored: true });
    }
    if (url.endsWith("/v1/chat/completions")) {
      upstreamRequest = JSON.parse(init.body);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"id":"chatcmpl-browser","choices":[{"delta":{"content":"Streamed answer."},"finish_reason":null}]}\n\n' +
            'data: {"id":"chatcmpl-browser","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            'data: [DONE]\n\n',
          ));
          controller.close();
        },
      }), { status: 200, headers: { "X-MundusX-Stream-Mode": "live-delta" } });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await streamChatTurn(
    response,
    {
      message: "Explain distributed systems briefly.",
      historyMessages: [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }],
      conversationId: "conversation-live",
      toolMode: false,
      voicePersona: "atlas",
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.content, "Streamed answer.");
  assert.equal(upstreamRequest.stream, true);
  assert.deepEqual(upstreamRequest.messages.map((entry) => entry.role), ["system", "user", "assistant", "user"]);
  assert.deepEqual(writes.map((entry) => entry.role), ["user", "assistant"]);
  assert.equal(writes[1].jobId, "chatcmpl-browser");
});

test("Hermes model discovery intentionally hides heterogeneous implementation details", () => {
  const result = openAiModelsResponse(configFromEnv({ MUNDUSX_CHAT_MODEL: "physical/private-model" }));
  assert.deepEqual(result.data, [{
    id: "mundusx-agnostic",
    object: "model",
    created: 0,
    owned_by: "mundusx-router",
  }]);
});

test("waitForChatJob retries a transient upstream 502 and returns the completed job", async () => {
  let calls = 0;
  const result = await waitForChatJob(
    "job-transient-502",
    { message: "Say hello", timeoutSeconds: 5 },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url) => {
      assert.equal(url, "https://uat.mundusx.ai/v1/jobs/job-transient-502");
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 502,
          text: async () => "upstream error",
        };
      }
      return jsonResponse({
        job: {
          job_id: "job-transient-502",
          status: "completed",
          output: "Done.",
        },
      });
    },
  );

  assert.equal(calls, 2);
  assert.equal(result.status, "completed");
  assert.equal(result.output, "Done.");
});

test("extracts only obvious weather locations", () => {
  assert.equal(extractWeatherLocation("weather in Warsaw please"), "Warsaw");
  assert.equal(extractWeatherLocation("temperature for New York right now"), "New York");
  assert.equal(extractWeatherLocation("Give me a history of Honda"), null);
  assert.equal(
    extractWeatherLocation(
      "Hey Atlas kindly introduce yourself and let me know what is the weather today in Newfing Germany and then tell me who is David Battalia",
    ),
    null,
  );
  assert.equal(extractWeatherLocation("weather in Manila and humidity please"), "Manila");
  assert.equal(
    extractWeatherLocation("weather in stuttgart germany today, and please tell me your name"),
    null,
  );
  assert.equal(
    extractWeatherLocation("What' the weather in Manila And What chool i in Baguio City they call it Saint Loui Univer ity"),
    null,
  );
});

test("extracts simple polynomial integrals", () => {
  assert.deepEqual(
    extractPolynomialIntegral("Evaluate the following indefinite integral: int (6x^2 - 4x + 3) dx"),
    {
      variable: "x",
      expression: "6x^2 - 4x + 3",
      result: "2x^3 - 2x^2 + 3x + C",
      terms: [
        { coefficient: 6, power: 2 },
        { coefficient: -4, power: 1 },
        { coefficient: 3, power: 0 },
      ],
    },
  );
  assert.equal(extractPolynomialIntegral("integrate sin(x) dx"), null);
  assert.equal(extractPolynomialIntegral("write a history of calculus"), null);
});

test("extracts simple linear equations", () => {
  assert.deepEqual(extractLinearEquation("solve this equation, 13(y+7)=3(y-1)"), {
    variable: "y",
    equation: "13(y+7)=3(y-1)",
    solution: -9.4,
    left: { coefficient: 13, constant: 91, variable: "y" },
    right: { coefficient: 3, constant: -3, variable: "y" },
  });
  assert.deepEqual(extractLinearEquation("find x: 2x + 5 = 11"), {
    variable: "x",
    equation: "2x+5=11",
    solution: 3,
    left: { coefficient: 2, constant: 5, variable: "x" },
    right: { coefficient: 0, constant: 11, variable: null },
  });
  assert.deepEqual(extractLinearEquation("x+x-25y, find x"), {
    variable: "x",
    equation: "x+x-25y=0",
    solutionExpression: "12.5y",
    targetCoefficient: 2,
    isolatedExpression: "25y",
    assumedZero: true,
  });
  assert.equal(extractLinearEquation("find y: 2x + 5 = 11"), null);
  assert.equal(extractLinearEquation("solve x^2 = 4"), null);
  assert.equal(extractLinearEquation("write a story with x=3"), null);
});

test("extracts simple polynomial derivatives", () => {
  assert.deepEqual(
    extractPolynomialDerivative("derivative of the polynomial function f(x) = 3x^2 + 5x is f(x) = 6x + 5 ? is this true"),
    {
      variable: "x",
      expression: "3x^2 + 5x",
      result: "6x + 5",
      terms: [
        { coefficient: 3, power: 2 },
        { coefficient: 5, power: 1 },
      ],
      proposed: "6x + 5",
      isCorrect: true,
    },
  );
  assert.deepEqual(
    extractPolynomialDerivative("differentiate 4x^3 - 2x"),
    {
      variable: "x",
      expression: "4x^3 - 2x",
      result: "12x^2 - 2",
      terms: [
        { coefficient: 4, power: 3 },
        { coefficient: -2, power: 1 },
      ],
      proposed: null,
      isCorrect: null,
    },
  );
  assert.equal(extractPolynomialDerivative("derivative of sin(x)"), null);
  assert.equal(extractPolynomialDerivative("write a history of derivatives"), null);
});

test("extracts polynomial subtraction with compact exponent notation", () => {
  assert.deepEqual(
    extractPolynomialSubtraction("Subtract 3(x2+1)2 from 6x3 -9x2 -13x -4"),
    {
      minuend: "6x^3 - 9x^2 - 13x - 4",
      subtrahend: "3x^4 + 6x^2 + 3",
      result: "-3x^4 + 6x^3 - 15x^2 - 13x - 7",
      terms: [
        { coefficient: -3, power: 4 },
        { coefficient: 6, power: 3 },
        { coefficient: -15, power: 2 },
        { coefficient: -13, power: 1 },
        { coefficient: -7, power: 0 },
      ],
    },
  );
  assert.equal(extractPolynomialSubtraction("subtract apples from oranges"), null);
});

test("extracts only factual summary topics", () => {
  assert.equal(extractFactualSummaryTopic("Give me a detailed history of BMW from its origins to today."), "BMW");
  assert.equal(extractFactualSummaryTopic("Who is Ada Lovelace?"), "Ada Lovelace");
  assert.equal(extractFactualSummaryTopic("Who i David Battalia"), "David Battalia");
  assert.equal(extractFactualSummaryTopic("who is sara duterte from ph?"), "sara duterte");
  assert.equal(extractFactualSummaryTopic("Write code for BMW inventory"), null);
  assert.equal(extractFactualSummaryTopic("Explain why a CUDA node can claim a job and fail."), null);
});

test("extracts current office-holder queries", () => {
  assert.deepEqual(extractCurrentOfficeQuery("Who is the current president of USA today 2026?"), {
    office: "president",
    relationProperty: "P6",
    country: "the United States",
    countryEntityId: "Q30",
  });
  assert.equal(extractCurrentOfficeQuery("Who is Ada Lovelace?"), null);
  assert.equal(extractCurrentOfficeQuery("Write a president speech for USA"), null);
});

test("reattaches tracked citation sources when polling a grounded job to completion", async () => {
  const config = configFromEnv({
    MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai",
    MUNDUSX_WEB_SEARCH_API_KEY: "test-key",
  });

  let jobStatus = "queued";
  const fetchImpl = async (url) => {
    if (String(url).includes("api.search.brave.com")) {
      return jsonResponse({
        web: {
          results: [{ title: "Tokyo Population", url: "https://example.com/tokyo", description: "Tokyo has about 14 million residents." }],
        },
      });
    }
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      return jsonResponse({
        job_id: "job-grounded-poll",
        job: { job_id: "job-grounded-poll", status: "queued", execution_mode: "tool" },
      });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs/job-grounded-poll");
    return jsonResponse({
      job: {
        job_id: "job-grounded-poll",
        status: jobStatus,
        output: "Tokyo has roughly 14 million residents [1].",
        execution_mode: "tool",
      },
    });
  };

  const submitted = await submitChatJob(
    { message: "How many people live in Tokyo right now?", toolMode: true },
    config,
    fetchImpl,
  );
  assert.equal(submitted.job_id, "job-grounded-poll");
  assert.equal(submitted.status, "queued");

  jobStatus = "completed";
  const polled = await pollChatJob("job-grounded-poll", config, fetchImpl);

  assert.equal(polled.tool, "web_search");
  assert.equal(polled.sources.length, 1);
  assert.equal(polled.sources[0].url, "https://example.com/tokyo");
});

test("polls chat job progress and final cleaned output", async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs/job-1");
    return jsonResponse({
      job: {
        job_id: "job-1",
        status: "completed",
        model: "Qwen/Test",
        execution_mode: "decompose",
        graph_execution_enabled: true,
        active_graph_node_id: "job.final",
        output: "llama.cpp mode=cuda; response=assistant: Done. Done.",
        graph: {
          final_node_id: "job.final",
          nodes: [
            { id: "job.origins", name: "Origins", status: "completed" },
            {
              id: "job.final",
              name: "Final synthesis",
              status: "running",
              responsibility: "merge",
              output: "llama.cpp mode=cuda; response=assistant: Final notes.",
            },
          ],
        },
      },
    });
  };

  const result = await pollChatJob(
    "job-1",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.output, "Done.");
  assert.equal(result.progress.total, 2);
  assert.equal(result.progress.completed, 1);
  assert.equal(result.progress.merging, true);
  assert.equal(result.progress.final_synthesis, true);
  assert.equal(result.progress.nodes[1].output, "");
});

test("reports a plain-text upstream failure without leaking a JSON parse error", async () => {
  await assert.rejects(
    () =>
      pollChatJob(
        "job-upstream-error",
        configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
        async () => ({
          ok: false,
          status: 502,
          text: async () => "upstream error",
        }),
      ),
    /MundusX upstream returned a non-JSON response: upstream error/,
  );
});

test("exposes a qualified reducer wait as a friendly degradation state", async () => {
  const result = await pollChatJob(
    "job-waiting-reducer",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () =>
      jsonResponse({
        job: {
          job_id: "job-waiting-reducer",
          status: "queued",
          graph_execution_enabled: true,
          active_graph_node_id: "reduce",
          degradation: {
            status: "waiting",
            code: "NO_CREDIBLE_REDUCER",
            stage: "reducer",
            message: "Expert work is preserved. Waiting for a qualified reducer before continuing.",
            retryable: true,
          },
          graph: {
            nodes: [
              { id: "chunk-1", name: "Origins", status: "completed", output: "Notes." },
              { id: "reduce", name: "Reduce partial results", responsibility: "reduce", status: "ready" },
            ],
          },
        },
      }),
  );

  assert.equal(result.status, "queued");
  assert.equal(result.degradation.code, "NO_CREDIBLE_REDUCER");
  assert.match(result.progress.processing, /Waiting for a qualified reducer/);
});

test("promotes completed section outputs when final synthesis is thin", async () => {
  const result = await pollChatJob(
    "job-product-plan",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () =>
      jsonResponse({
        job: {
          job_id: "job-product-plan",
          status: "completed",
          execution_mode: "auto",
          graph_execution_enabled: true,
          output: "llama.cpp mode=cuda; response=## Scope and constraints",
          graph: {
            final_node_id: "job.final",
            nodes: [
              {
                id: "job.product_description",
                name: "Product description",
                status: "completed",
                responsibility: "section",
                output: "llama.cpp mode=cuda; response=User-facing product description answer.",
              },
              {
                id: "job.technical_architecture",
                name: "Technical architecture",
                status: "completed",
                responsibility: "section",
                output: "llama.cpp mode=cuda; response=Architecture answer.",
              },
              {
                id: "job.final",
                name: "Final synthesis",
                status: "completed",
                responsibility: "merge",
                output: "llama.cpp mode=cuda; response=## Scope and constraints",
              },
            ],
          },
        },
      }),
  );

  assert.match(result.output, /## Product description/);
  assert.match(result.output, /User-facing product description answer/);
  assert.match(result.output, /## Technical architecture/);
  assert.match(result.output, /Architecture answer/);
  assert.doesNotMatch(result.output, /^## Scope and constraints$/);
  assert.equal(result.progress.final_synthesis, true);
  assert.equal(result.progress.nodes[0].responsibility, "section");
  assert.equal(result.progress.nodes[2].responsibility, "merge");
});

test("keeps concise final answers instead of exposing internal graph node headings", async () => {
  const result = await pollChatJob(
    "job-capital",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => jsonResponse({
      job: {
        job_id: "job-capital",
        status: "completed",
        output: "The capital of the Philippines is Manila.",
        graph_execution_enabled: true,
        graph: {
          nodes: [{
            id: "execute",
            name: "Execute request",
            status: "completed",
            responsibility: "section",
            output: "The capital of the Philippines is Manila.",
          }],
        },
      },
    }),
  );

  assert.equal(result.output, "The capital of the Philippines is Manila.");
  assert.doesNotMatch(result.output, /Execute request/);
});

test("uses parent status for single direct chat job progress", async () => {
  const assigned = await pollChatJob(
    "job-single",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () =>
      jsonResponse({
        job: {
          job_id: "job-single",
          status: "assigned",
          assigned_node_id: "node-7",
          execution_mode: "auto",
          graph_execution_enabled: false,
          plan: { strategy: "single_job" },
          graph: {
            nodes: [
              { id: "job.direct_response", name: "Direct response", status: "ready" },
            ],
          },
        },
      }),
  );

  assert.equal(assigned.progress.total, 1);
  assert.equal(assigned.progress.running, 1);
  assert.equal(assigned.progress.waiting, 0);
  assert.equal(assigned.progress.processing, "Direct response");
  assert.equal(assigned.progress.nodes[0].status, "assigned");
  assert.equal(assigned.progress.nodes[0].assigned_node_id, "node-7");

  const completed = await pollChatJob(
    "job-single",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () =>
      jsonResponse({
        job: {
          job_id: "job-single",
          status: "completed",
          assigned_node_id: "node-7",
          execution_mode: "auto",
          graph_execution_enabled: false,
          output: "llama.cpp mode=cuda; response=9",
          graph: {
            nodes: [
              { id: "job.direct_response", name: "Direct response", status: "ready" },
            ],
          },
        },
      }),
  );

  assert.equal(completed.progress.completed, 1);
  assert.equal(completed.progress.waiting, 0);
  assert.equal(completed.progress.final_synthesis, false);
  assert.equal(completed.progress.nodes[0].status, "completed");
  assert.equal(completed.progress.nodes[0].output, "9");
  assert.equal(completed.progress.nodes[0].output_chars, 1);
  assert.equal(completed.progress.nodes[0].estimated_output_tokens, 1);
});

test("returns compact completed chunk outputs for decomposed jobs", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      job: {
        job_id: "job-2",
        status: "assigned",
        execution_mode: "decompose",
        graph_execution_enabled: true,
        graph: {
          nodes: [
            {
              id: "job.origins",
              name: "Origins",
              status: "completed",
              assigned_node_id: "node-1",
              latency_ms: 18000,
              queue_wait_ms: 500,
              output_chars: 48,
              estimated_output_tokens: 12,
              effective_max_tokens: 256,
              output: "llama.cpp mode=cuda; response=assistant: Founded in 1916. Founded in 1916.",
            },
            { id: "job.modern", name: "Modern era", status: "running" },
            {
              id: "job.notes",
              name: "Compile and usage notes",
              status: "completed",
              output: "Do not include any implementation details. Do not include any source code. Do not include examples.",
            },
          ],
        },
      },
    });

  const result = await pollChatJob(
    "job-2",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.progress.nodes[0].output, "Founded in 1916.");
  assert.equal(result.progress.nodes[0].assigned_node_id, "node-1");
  assert.equal(result.progress.nodes[0].latency_ms, 18000);
  assert.equal(result.progress.nodes[0].queue_wait_ms, 500);
  assert.equal(result.progress.nodes[0].output_chars, 48);
  assert.equal(result.progress.nodes[0].estimated_output_tokens, 12);
  assert.equal(result.progress.nodes[0].effective_max_tokens, 256);
  assert.equal(result.progress.nodes[1].output, "");
  assert.equal(result.progress.nodes[2].output, "");
  assert.equal(result.progress.final_synthesis, false);
});

test("returns verified completed graph sections as a progressive partial response", async () => {
  const calls = [];
  const result = await pollChatJob(
    "job-progressive-batches",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url) => {
      calls.push(url);
      return jsonResponse({
        job: {
          job_id: "job-progressive-batches",
          status: "assigned",
          execution_mode: "decompose",
          graph_execution_enabled: true,
          graph: {
            nodes: [
              {
                id: "scope",
                name: "Scope request",
                status: "completed",
                responsibility: "scope",
                output: "response=The request covers origins and current impact.",
              },
              {
                id: "foundations",
                name: "Analyze foundations",
                status: "completed",
                responsibility: "chunk_analysis",
                output: "response=The organization was founded in 2015.",
              },
              {
                id: "impact",
                name: "Analyze current impact",
                status: "running",
                responsibility: "chunk_analysis",
              },
              {
                id: "synthesize",
                name: "Synthesize final answer",
                status: "waiting",
                responsibility: "merge",
              },
            ],
          },
        },
      });
    },
    { conversationId: "conv-progressive" },
  );

  assert.equal(result.status, "assigned");
  assert.equal(result.output, "");
  assert.equal(result.partial, true);
  assert.equal(result.completed_batches, 2);
  assert.match(result.partial_output, /## Scope request/);
  assert.match(result.partial_output, /## Analyze foundations/);
  assert.doesNotMatch(result.partial_output, /Analyze current impact|Synthesize final answer/);
  assert.ok(!calls.some((url) => url.includes("/v1/conversations/")));
});

test("exposes runtime metrics from completed chunk output", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      job: {
        job_id: "job-runtime-metrics",
        status: "completed",
        execution_mode: "decompose",
        graph_execution_enabled: true,
        graph: {
          nodes: [
            {
              id: "job.direct",
              name: "Direct response",
              status: "completed",
              effective_max_tokens: 256,
              output:
                "llama.cpp mode=cuda; total_duration=3000000000; load_duration=500000000; prompt_eval_count=20; prompt_eval_duration=100000000; prompt_eval_rate=200; eval_count=40; eval_duration=2000000000; eval_rate=20; response=Done.",
            },
          ],
        },
      },
    });

  const result = await pollChatJob(
    "job-runtime-metrics",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.deepEqual(result.progress.nodes[0].runtime_metrics, {
    total_duration_ms: 3000,
    load_duration_ms: 500,
    prompt_eval_count: 20,
    prompt_eval_duration_ms: 100,
    prompt_eval_rate: 200,
    eval_count: 40,
    eval_duration_ms: 2000,
    eval_rate: 20,
  });
  assert.deepEqual(result.progress.token_usage, {
    input_tokens: 20,
    output_tokens: 40,
    total_tokens: 60,
    max_output_tokens: 256,
    output_budget_percent: 16,
    source: "runtime",
  });
});

test("labels aggregate token usage as estimated when runtime counters are unavailable", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      job: {
        job_id: "job-estimated-token-usage",
        status: "completed",
        prompt: "12345678",
        system_prompt: "12345678",
        max_tokens: 100,
        graph_execution_enabled: false,
        graph: {
          nodes: [
            {
              id: "job.direct",
              name: "Direct response",
              status: "completed",
              output: "response=12345678",
            },
          ],
        },
      },
    });

  const result = await pollChatJob(
    "job-estimated-token-usage",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.deepEqual(result.progress.token_usage, {
    input_tokens: 5,
    output_tokens: 2,
    total_tokens: 7,
    max_output_tokens: 100,
    output_budget_percent: 2,
    source: "estimated",
  });
});

test("exposes runtime metrics from llama server timings", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      job: {
        job_id: "job-llama-server-metrics",
        status: "completed",
        execution_mode: "decompose",
        graph_execution_enabled: true,
        graph: {
          nodes: [
            {
              id: "job.direct",
              name: "Direct response",
              status: "completed",
              output:
                'llama.cpp mode=persistent-warm-cuda; timings={"prompt_n":12,"prompt_ms":80,"prompt_per_second":150,"predicted_n":24,"predicted_ms":1200,"predicted_per_second":20}; response=Done.',
            },
          ],
        },
      },
    });

  const result = await pollChatJob(
    "job-llama-server-metrics",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.progress.nodes[0].runtime_metrics.prompt_eval_count, 12);
  assert.equal(result.progress.nodes[0].runtime_metrics.prompt_eval_duration_ms, 80);
  assert.equal(result.progress.nodes[0].runtime_metrics.prompt_eval_rate, 150);
  assert.equal(result.progress.nodes[0].runtime_metrics.eval_count, 24);
  assert.equal(result.progress.nodes[0].runtime_metrics.eval_duration_ms, 1200);
  assert.equal(result.progress.nodes[0].runtime_metrics.eval_rate, 20);
});

test("hides completed chunk output when it is leaked planner text for another section", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      job: {
        job_id: "job-leaked-planner",
        status: "completed",
        execution_mode: "decompose",
        graph_execution_enabled: true,
        graph: {
          nodes: [
            {
              id: "job.origins",
              name: "Origins and founders",
              status: "completed",
              output:
                "MundusX subjob: Name: Expansion Responsibility: section Required output: Explain the expansion, including significant milestones and major events, for the requested topic. Name: Cloud era Required output: Explain the cloud era, including significant milestones and major events, for the requested topic.",
            },
            {
              id: "job.modern",
              name: "Modern era",
              status: "completed",
              output:
                "Modern era: Microsoft expanded cloud and AI services while continuing enterprise software growth.",
            },
          ],
        },
      },
    });

  const result = await pollChatJob(
    "job-leaked-planner",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.progress.nodes[0].output, "");
  assert.equal(
    result.progress.nodes[1].output,
    "Modern era: Microsoft expanded cloud and AI services while continuing enterprise software growth.",
  );
});

test("hides completed chunk output when it is only section instructions", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      job: {
        job_id: "job-instruction-only-section",
        status: "completed",
        execution_mode: "decompose",
        graph_execution_enabled: true,
        graph: {
          nodes: [
            {
              id: "job.ai_era",
              name: "AI Era",
              status: "completed",
              output:
                "Stop before the next section begins. Use plain prose or compact bullets and keep the answer focused on the current section title. Write only the AI Era section requested by the user. Do not include any other requested section. Return only the user-facing content for the current section. Do not repeat these instructions, do not describe the plan, and do not continue the user's prompt. Do not write content for these other sections: Founding, Early Years, Expansion, Cloud Era, Summary.",
            },
            {
              id: "job.summary",
              name: "Summary",
              status: "completed",
              output:
                "The answer should be a single, clear, and concise sentence that is informative and to the point. The answer should not include any section headings or subheadings, and it should not be overly verbose or detailed.",
            },
          ],
        },
      },
    });

  const result = await pollChatJob(
    "job-instruction-only-section",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.progress.nodes[0].output, "");
  assert.equal(result.progress.nodes[1].output, "");
});

test("trims completed section output before it bleeds into later sections", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      job: {
        job_id: "job-section-bleed",
        status: "completed",
        execution_mode: "decompose",
        graph_execution_enabled: true,
        graph: {
          nodes: [
            {
              id: "job.origins",
              name: "Origins and founders",
              status: "completed",
              output:
                "Origins and Founders: Microsoft was founded in 1975 by Bill Gates and Paul Allen.\n\n- Early Years: Microsoft developed software for early personal computers.\n- Expansion: Microsoft grew through Windows and enterprise software.",
            },
          ],
        },
      },
    });

  const result = await pollChatJob(
    "job-section-bleed",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(
    result.progress.nodes[0].output,
    "Origins and Founders: Microsoft was founded in 1975 by Bill Gates and Paul Allen.",
  );
  assert.doesNotMatch(result.progress.nodes[0].output, /Early Years|Expansion/);
});

test("exposes blocked graph dependencies in chat progress", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      job: {
        job_id: "job-code",
        status: "assigned",
        execution_mode: "decompose",
        graph_execution_enabled: true,
        active_graph_node_id: "job.scope",
        graph: {
          nodes: [
            {
              id: "job.scope",
              name: "Scope and constraints",
              status: "running",
              responsibility: "analysis",
            },
            {
              id: "job.backend",
              name: "Backend implementation",
              status: "waiting",
              responsibility: "backend",
              depends_on: ["job.scope"],
              blocked_by: ["job.scope"],
            },
            {
              id: "job.tests",
              name: "Regression tests",
              status: "waiting",
              responsibility: "tests",
              depends_on: ["job.backend"],
              blocked_by: ["job.backend"],
            },
          ],
        },
      },
    });

  const result = await pollChatJob(
    "job-code",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.progress.processing, "Scope and constraints");
  assert.deepEqual(result.progress.nodes[1].blocked_by, ["Scope and constraints"]);
  assert.deepEqual(result.progress.nodes[2].depends_on, ["Backend implementation"]);
  assert.deepEqual(result.progress.nodes[2].blocked_by, ["Backend implementation"]);
});

test("derives completed chunk metrics when the control plane reports zeros", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      job: {
        job_id: "job-zero-metrics",
        status: "completed",
        execution_mode: "decompose",
        graph_execution_enabled: true,
        max_tokens: 256,
        graph: {
          nodes: [
            {
              id: "job.direct_response",
              name: "Direct response",
              status: "completed",
              assigned_node_id: "node-7c540437d8aa3fc6",
              latency_ms: 0,
              queue_wait_ms: 0,
              output_chars: 0,
              estimated_output_tokens: 0,
              effective_max_tokens: 0,
              output: "llama.cpp mode=cuda; response=Current president of the United States: Donald Trump.",
            },
          ],
        },
      },
    });

  const result = await pollChatJob(
    "job-zero-metrics",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  const node = result.progress.nodes[0];
  assert.equal(node.assigned_node_id, "node-7c540437d8aa3fc6");
  assert.equal(node.latency_ms, null);
  assert.equal(node.queue_wait_ms, null);
  assert.equal(node.output_chars, 53);
  assert.equal(node.estimated_output_tokens, 14);
  assert.equal(node.effective_max_tokens, 256);
  assert.equal(node.output, "Current president of the United States: Donald Trump.");
});

test("cleans worker metadata and repeated role-prefixed output", () => {
  const output = cleanChatOutput(
    "llama.cpp mode=cuda; model=Qwen/Qwen2.5-1.5B-Instruct; path=C:\\Users\\batal\\.opengpu\\models\\qwen.gguf; max_tokens=512; response=system: The President of the United States is Donald Trump. He is the 47th President of the United States. He is the 47th President of the United States. He is the 47th President of the United States.",
  );

  assert.equal(
    output,
    "The President of the United States is Donald Trump. He is the 47th President of the United States.",
  );
  assert.doesNotMatch(output, /llama\.cpp|path=|response=|system:/i);
});

test("removes assistant preambles before rendering chat output", () => {
  const output = cleanChatOutput(
    "llama.cpp mode=cuda; response=MundusX Chat: Certainly! Here is a brief history of Apple Company: 1. **Founding**: Apple was founded in 1976. 2. **Early Years**: Apple released the Apple II.",
  );

  assert.equal(
    output,
    "1. **Founding**: Apple was founded in 1976. 2. **Early Years**: Apple released the Apple II.",
  );
  assert.doesNotMatch(output, /MundusX Chat|Certainly|Here is/i);
});

test("removes expanded request leakage before complete-code answers", () => {
  const output = cleanChatOutput(
    "I want to understand how it works. Please provide a complete source code, including all necessary imports, classes, methods, file operations, menu/input handling, and error handling. I want to see how the magic square works and how it is generated. Please provide a detailed explanation of the code. Certainly! Below is a complete Java program that generates a 3x3 magic square. A magic square is a square grid of numbers where each row adds to the same value.\n```java\nimport java.util.Scanner;\npublic class MagicSquare {\n  public static void main(String[] args) {}\n}\n```",
  );

  assert.match(output, /^```java/);
  assert.match(output, /```java[\s\S]*public class MagicSquare/);
  assert.doesNotMatch(output, /I want to understand|Please provide|Certainly|Below is|A magic square is/i);
});

test("removes prompt-completion leakage and duplicate fenced code blocks", () => {
  const output = cleanChatOutput(
    "llama.cpp mode=persistent-warm-cuda; response=I want to use it to generate a Fibonacci sequence up to the 10th number. I also want to add a function that checks if a given number is part of the sequence. Can you provide me with a complete code example?\n\n```python\ndef fibonacci(n):\n    return [0, 1]\n```\n\n```python\ndef fibonacci(n):\n    return [0, 1]\n```",
  );

  assert.match(output, /^```python/);
  assert.equal((output.match(/```python/g) || []).length, 1);
  assert.doesNotMatch(output, /I want to use it|Can you provide me/i);
});

test("preserves complete control-plane code assemblies before prose cleanup", () => {
  const output = cleanChatOutput(
    "Complete runnable implementation\n```javascript\nconst express = require('express');\nconst app = express();\napp.get('/customers', (_req, res) => res.json([]));\napp.post('/customers', (req, res) => res.status(201).json(req.body));\napp.put('/customers/:id', (req, res) => res.json(req.body));\napp.delete('/customers/:id', (_req, res) => res.status(204).end());\napp.listen(3000);\n```\n\nMarkdown documentation\nRun with `node server.js`.\n\nIndependent code review\nThe CRUD routes are complete.",
  );

  assert.match(output, /^```javascript/);
  assert.match(output, /app\.listen\(3000\);\n```/);
  assert.match(output, /Markdown documentation/);
  assert.match(output, /Independent code review/);
  assert.equal((output.match(/```/g) || []).length, 2);
});

test("deduplicates repeated source artifacts in a control-plane assembly", () => {
  const source = "```javascript\nconst express = require('express');\nconst app = express();\napp.get('/customers', (_req, res) => res.json([]));\napp.post('/customers', (req, res) => res.status(201).json(req.body));\napp.put('/customers/:id', (req, res) => res.json(req.body));\napp.delete('/customers/:id', (_req, res) => res.status(204).end());\napp.listen(3000);\n```";
  const output = cleanChatOutput(
    `Complete runnable implementation\n${source}\n${source}\n\nMarkdown documentation\nRun the server.\n\nIndependent code review\nThe routes are complete.`,
  );

  assert.equal((output.match(/```javascript/g) || []).length, 1);
  assert.match(output, /app\.listen\(3000\);/);
  assert.match(output, /Markdown documentation/);
  assert.match(output, /Independent code review/);
});

test("keeps JavaScript spread syntax in complete source artifacts", () => {
  const output = cleanChatOutput(
    "Complete runnable implementation\n```javascript\nconst current = { id: 1, name: 'Ada' };\nconst update = { name: 'Grace' };\nconst customer = { ...current, ...update };\nmodule.exports = customer;\n```",
  );

  assert.match(output, /^```javascript/);
  assert.match(output, /\{ \.\.\.current, \.\.\.update \}/);
  assert.doesNotMatch(output, /incomplete placeholder code/i);
});

test("accepts URL template literals in complete JavaScript source", () => {
  const prompt = "Create a Node.js Express CRUD API for customers.";
  const output = "```javascript\nconst express = require('express');\nconst app = express();\napp.get('/customers', (_req, res) => res.json([]));\napp.post('/customers', (req, res) => res.status(201).json(req.body));\napp.put('/customers/:id', (req, res) => res.json(req.body));\napp.delete('/customers/:id', (_req, res) => res.status(204).end());\nconst port = 3000;\napp.listen(port, () => console.log(`Server running at http://localhost:${port}`));\n```";

  assert.deepEqual(detectCompleteCodeQualityFlags(output, prompt), []);
});

test("removes orphaned prompt continuation fragments before answers", () => {
  const output = cleanChatOutput(
    "matrix. The program should take a 3x3 matrix as input, perform the magic square operation, and print the result.",
  );

  assert.match(output, /explanation instead of source code/i);
  assert.doesNotMatch(output, /^matrix\.|The program should/i);
});

test("removes pre-code narration so complete program answers start with code", () => {
  const output = cleanChatOutput(
    "The program should take a 3x3 matrix as input, perform the magic square operation on it, and then print the result. The explanation is below.\n```java\npublic class MagicSquare {\n  public static void main(String[] args) {}\n}\n```\nThis code reads input and prints the result.",
  );

  assert.match(output, /^```java/);
  assert.match(output, /public class MagicSquare/);
  assert.match(output, /This code reads input/);
  assert.doesNotMatch(output, /^The program should/i);
});

test("removes plain response labels before rendering chat output", () => {
  const output = cleanChatOutput(
    "Response: My name is Atlas.",
  );

  assert.equal(output, "My name is Atlas.");
  assert.doesNotMatch(output, /^Response:/i);
});

test("removes leaked markdown skill instructions before rendering chat output", () => {
  const output = cleanChatOutput(
    "md # Router Skill Route requests conservatively. # Formatter Skill Answer directly and cleanly. # Translation Skill Return only the translated text.",
  );

  assert.equal(output, "MundusX returned an empty response. Please try again.");
  assert.doesNotMatch(output, /Router Skill|Formatter Skill|Translation Skill/i);
});

test("removes leaked persona labels before rendering chat output", () => {
  const output = cleanChatOutput(
    "for MundusX? Marie: My vision for MundusX is to democratize access to AI, making it affordable and beneficial for everyone.",
  );

  assert.equal(
    output,
    "My vision for MundusX is to democratize access to AI, making it affordable and beneficial for everyone.",
  );
  assert.doesNotMatch(output, /^for MundusX\?|^Marie:/i);
});

test("removes leaked system prompt text after direct identity answers", () => {
  const output = cleanChatOutput(
    "Yes, I am Atlas, the MundusX assistant. MundusX Chat is the product interface you are speaking through. Use the Atlas persona for this response. Atlas represents the MundusX open-source team's vision of making artificial intelligence accessible, affordable, and beneficial for everyone. Answer the user's request directly.",
  );

  assert.equal(output, "Yes, I am Atlas, the MundusX assistant.");
  assert.doesNotMatch(output, /MundusX Chat is the product interface|Use the Atlas persona|Answer the user's request/i);
});

test("removes unasked who-is expansion prompts from model output", () => {
  const output = cleanChatOutput(
    "What is his role in the MundusX community? Lichard Baliuag is a member of the MundusX community.",
  );

  assert.equal(output, "Lichard Baliuag is a member of the MundusX community.");
  assert.doesNotMatch(output, /What is his role/i);
});

test("removes leaked subjob instructions while keeping chunk content", () => {
  const output = cleanChatOutput(
    "Do not include any external links or references. Do not generate any output that is not factual and directly related to the user's request. MundusX subjob: Name: History Responsibility: section Required output: Explain the history of Mercedes-Benz from its origins to today. Write the factual content for this section only, in plain prose or compact bullets. Origins and founders: Mercedes-Benz was founded in 1926 by Gottlieb Daimler and Wilhelm Maybach.",
  );

  assert.equal(
    output,
    "Origins and founders: Mercedes-Benz was founded in 1926 by Gottlieb Daimler and Wilhelm Maybach.",
  );
  assert.doesNotMatch(output, /Do not include|Required output|MundusX subjob|Write the factual/i);
});

test("removes embedded section instruction leaks from decomposed answers", () => {
  const output = cleanChatOutput(
    "## Product description\nMundusX AI coordinates contributor GPUs for useful AI work.\n\n## Technical architecture Avoid jargon and technical terms unless absolutely necessary. Use a formal tone. Name: Pricing and credits Responsibility: section Required output: Outline the pricing model, credits, and revenue streams. Include details on how MundusX will be compensated for its services. Write the factual content for this section only, in plain prose or compact bullets. Pricing and credits: Contributors earn credits for completed work and users spend credits for jobs.\n\nName: Go-to-market plan Required output: Develop a comprehensive go-to-market strategy, including target audience, marketing channels, sales approach, and timeline. Go-to-market plan: Start with developers and GPU contributors.",
  );

  assert.match(output, /## Product description/);
  assert.match(output, /MundusX AI coordinates contributor GPUs/);
  assert.match(output, /Pricing and credits: Contributors earn credits/);
  assert.doesNotMatch(output, /Avoid jargon|Use a formal tone|Required output|Responsibility|Write the factual/i);
});

test("removes deprecated-directly instruction leaks from decomposed answers", () => {
  const output = cleanChatOutput(
    "## Origins and founders directly is deprecated. instead. Microsoft was founded in 1975 by Bill Gates and Paul Allen.\n\n## Early years sections are returned directly are deprecated. Microsoft grew by selling software for early personal computers.",
  );

  assert.match(output, /## Origins and founders/);
  assert.match(output, /Microsoft was founded in 1975/);
  assert.match(output, /## Early years/);
  assert.doesNotMatch(output, /directly is deprecated|sections are returned directly|instead\./i);
});

test("removes inline selected skill labels from rendered output", () => {
  const output = cleanChatOutput(
    "Founding: Microsoft was founded in 1975. [router] Route requests conservatively. [formatter] Answer directly and cleanly. [chunk-planner] Chunk only when useful.",
  );

  assert.equal(output, "Founding: Microsoft was founded in 1975.");
  assert.doesNotMatch(output, /\[router\]|\[formatter\]|\[chunk-planner\]/);
});

test("removes leaked code subjob instructions and keeps C code", () => {
  const output = cleanChatOutput(
    "MundusX code subjob: Name: Student record storage Responsibility: implementation Required output: Implement a function to store student records in a list. - The function should return the list of student records. h> // Helper function to validate input void validate_input(char *input) { /* validation */ }",
  );

  assert.match(output, /^\/\/ Helper function/);
  assert.match(output, /void validate_input\(char \*input\)/);
  assert.doesNotMatch(output, /MundusX code subjob|Required output|Responsibility|The function should/i);
});

test("rejects placeholder-only code as incomplete", () => {
  const output = cleanChatOutput(
    "```java\nFile:\nIOException;\nScanner;\npublic class StudentManager {\n  properties;\n  public void addStudent(String id, String name, String bdate) {\n    // Add student to properties file // ...\n  }\n  public void deleteStudent(String id) {\n    // Delete student from properties file // ...\n  }\n  private void saveToFile() {\n    // Save...\n  }\n}\n```",
  );

  assert.match(output, /incomplete placeholder code/i);
  assert.doesNotMatch(output, /public class StudentManager/);
});

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test("cleans embedded role leakage and repeated answer spam", () => {
  const output = cleanChatOutput(
    "So what is the point of this article? system: The article is about election coverage. The article is about election coverage. The article is written in a balanced way.",
  );

  assert.equal(
    output,
    "The article is about election coverage. The article is written in a balanced way.",
  );
  assert.doesNotMatch(output, /system:|So what is the point/i);
});

test("cleans duplicated opening clauses before rendering chat output", () => {
  const output = cleanChatOutput(
    "Ethereum blockchain is a decentralized, open-source platform that allows developers to build and deploy decentralized applications. Ethereum blockchain is a decentralized, open-source platform that allows developers to build and deploy decentralized applications. It supports smart contracts and transparent execution.",
  );

  assert.equal(
    output,
    "Ethereum blockchain is a decentralized, open-source platform that allows developers to build and deploy decentralized applications. It supports smart contracts and transparent execution.",
  );
});

test("cleans near-duplicate intent loops before rendering chat output", () => {
  const output = cleanChatOutput(
    "I am looking for a way to create a conversation that has context and context compression. I want to be able to start a conversation and have it flow naturally while also being able to compress the context as the conversation progresses. I want to be able to start a conversation and have it flow naturally while also be able to compress the context as the conversation progresses. Use a rolling summary plus recent turns.",
  );

  assert.equal(
    output,
    "I am looking for a way to create a conversation that has context and context compression. I want to be able to start a conversation and have it flow naturally while also being able to compress the context as the conversation progresses. Use a rolling summary plus recent turns.",
  );
});

test("returns a user-facing fallback for empty cleaned responses", () => {
  assert.equal(
    cleanChatOutput("llama.cpp mode=cuda; response=system:"),
    "MundusX returned an empty response. Please try again.",
  );
});

test("buildHistoryContext returns empty string for no history", () => {
  assert.equal(buildHistoryContext([]), "");
  assert.equal(buildHistoryContext(undefined), "");
});

test("buildHistoryContext caps by turn count and keeps the most recent", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `turn-${index}`,
  }));

  const context = buildHistoryContext(messages, 10_000, 8);
  const lines = context.split("\n");

  assert.equal(lines.length, 16);
  assert.equal(lines[0], "User: turn-4");
  assert.equal(lines[lines.length - 1], "Assistant: turn-19");
});

test("buildHistoryContext caps by character budget and keeps the most recent", () => {
  const messages = [
    { role: "user", content: "a".repeat(100) },
    { role: "assistant", content: "b".repeat(100) },
    { role: "user", content: "c".repeat(100) },
  ];

  const context = buildHistoryContext(messages, 150, 8);
  const lines = context.split("\n");

  assert.equal(lines.length, 1);
  assert.equal(lines[0], `User: ${"c".repeat(100)}`);
});

test("buildHistoryContext formats turns chronologically with role labels", () => {
  const context = buildHistoryContext([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);

  assert.equal(context, "User: hello\nAssistant: hi there");
});

test("compresses older history while preserving recent turns within a token budget", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `turn-${index} ${"detail ".repeat(30)}`,
  }));

  const result = buildCompressedHistoryContext(messages, {
    maxTokens: 180,
    recentMessages: 4,
  });

  assert.equal(result.compressed, true);
  assert.equal(result.source_messages, 20);
  assert.equal(result.recent_messages, 4);
  assert.match(result.text, /Earlier conversation compressed from 16 messages/);
  assert.match(result.text, /turn-16/);
  assert.match(result.text, /turn-19/);
  assert.ok(result.estimated_tokens <= 180);
});

test("removes the just-submitted user message from reconstructed history", () => {
  const result = buildCompressedHistoryContext([
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "Continue the discussion." },
  ], {
    currentMessage: "Continue the discussion.",
    maxTokens: 500,
  });

  assert.equal(result.duplicate_messages_removed, 1);
  assert.doesNotMatch(result.text, /Continue the discussion/);
  assert.match(result.text, /Earlier question/);
  assert.match(result.text, /Earlier answer/);
});

test("tracks model context occupancy and compression for submitted chat jobs", async () => {
  let submittedBody = null;
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: index === 19 ? "user" : index % 2 === 0 ? "user" : "assistant",
    content: index === 19 ? "Continue the discussion." : `history-${index} ${"detail ".repeat(90)}`,
  }));
  const fetchImpl = async (url, init = {}) => {
    if (url.includes("/v1/conversations/conv-context/messages") && init.method === "POST") {
      return jsonResponse({ id: 1 }, true, 201);
    }
    if (url.includes("/v1/conversations/conv-context/messages")) {
      return jsonResponse({ conversation_id: "conv-context", messages: history });
    }
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [{
        node_id: "node-context",
        state: "ready",
        policy_allowed: true,
        computed_policy_allowed: true,
        available_memory_mb: 8192,
        available_gpu_percent: 70,
        capabilities: {
          max_context_tokens: 4096,
          models: [{ name: "Qwen/Qwen2.5-7B-Instruct", context_tokens: 4096 }],
        },
        worker_health: {
          healthy: true,
          runtime_ready: true,
          model_name: "Qwen/Qwen2.5-7B-Instruct",
          cuda_device_available: true,
        },
      }] });
    }
    if (url === "https://uat.mundusx.ai/v1/jobs") {
      submittedBody = JSON.parse(init.body);
      return jsonResponse({
        job_id: "job-context",
        job: { job_id: "job-context", status: "queued", prompt: submittedBody.prompt, system_prompt: submittedBody.system_prompt, max_tokens: submittedBody.max_tokens },
      });
    }
    if (url === "https://uat.mundusx.ai/v1/jobs/job-context") {
      return jsonResponse({ job: {
        job_id: "job-context",
        status: "completed",
        prompt: submittedBody.prompt,
        system_prompt: submittedBody.system_prompt,
        max_tokens: submittedBody.max_tokens,
        graph_execution_enabled: false,
        graph: { nodes: [{
          id: "job.direct",
          name: "Direct response",
          status: "completed",
          effective_max_tokens: submittedBody.max_tokens,
          output: "llama.cpp mode=cuda; prompt_eval_count=500; eval_count=100; response=Done.",
        }] },
        output: "llama.cpp mode=cuda; prompt_eval_count=500; eval_count=100; response=Done.",
      } });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await submitChatJob(
    { message: "Continue the discussion.", conversationId: "conv-context" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.match(submittedBody.system_prompt, /Earlier conversation compressed from/);
  assert.equal((submittedBody.system_prompt.match(/Continue the discussion\./g) ?? []).length, 0);
  assert.equal(result.progress.context_usage.context_window_tokens, 4096);
  assert.equal(result.progress.context_usage.history_compressed, true);
  assert.equal(result.progress.context_usage.duplicate_messages_removed, 1);
  assert.ok(result.progress.context_usage.reserved_percent < 100);

  const completed = await pollChatJob(
    "job-context",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
  assert.equal(completed.progress.context_usage.source, "runtime");
  assert.equal(completed.progress.context_usage.used_tokens, 600);
  assert.equal(
    completed.progress.context_usage.reserved_tokens,
    500 + submittedBody.max_tokens + 256,
  );
});

test("buildRelevantHistoryContext keeps only code and conversion instructions for follow-ups", () => {
  const context = buildRelevantHistoryContext([
    { role: "user", content: "Tell me a joke." },
    { role: "assistant", content: "An unrelated answer." },
    { role: "user", content: "Convert this Java program to Node.js." },
    { role: "assistant", content: "```javascript\nconst value = 42;\n```" },
    { role: "user", content: "What time is it?" },
  ], true);

  assert.match(context, /Convert this Java program to Node\.js/);
  assert.match(context, /const value = 42/);
  assert.doesNotMatch(context, /joke|unrelated|What time/);
});

test("submitChatJob persists the user turn when a conversationId is provided", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [] });
    }
    if (url.includes("/v1/conversations/")) {
      return jsonResponse({ id: 1, conversation_id: "conv-1", role: "user", content: "hello" }, true, 201);
    }
    return jsonResponse({
      job_id: "job-1",
      status: "queued",
      job: { job_id: "job-1", status: "queued" },
    });
  };

  await submitChatJob(
    { message: "hello", conversationId: "conv-1" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  const messageCalls = calls.filter(
    (call) => call.url.includes("/v1/conversations/conv-1/messages") && call.init?.method === "POST",
  );
  assert.equal(messageCalls.length, 1);
  const body = JSON.parse(messageCalls[0].init.body);
  assert.equal(body.role, "user");
  assert.equal(body.content, "hello");
});

test("submitChatJob skips conversation memory entirely without a conversationId", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [] });
    }
    return jsonResponse({
      job_id: "job-1",
      status: "queued",
      job: { job_id: "job-1", status: "queued" },
    });
  };

  await submitChatJob(
    { message: "hello" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.ok(!calls.some((url) => url.includes("/v1/conversations/")));
});

test("submitChatJob folds prior conversation history into the system prompt for the generic path", async () => {
  const fetchImpl = async (url, init) => {
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [] });
    }
    if (url.includes("/v1/conversations/conv-1/messages") && (!init || init.method !== "POST")) {
      return jsonResponse({
        conversation_id: "conv-1",
        messages: [
          { role: "user", content: "What is MundusX?" },
          { role: "assistant", content: "A decentralized compute network." },
        ],
      });
    }
    if (url.includes("/v1/conversations/")) {
      return jsonResponse({ id: 1 }, true, 201);
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    const body = JSON.parse(init.body);
    assert.match(body.system_prompt, /Prior conversation \(most recent last\):/);
    assert.match(body.system_prompt, /User: What is MundusX\?/);
    assert.match(body.system_prompt, /Assistant: A decentralized compute network\./);
    return jsonResponse({
      job_id: "job-2",
      status: "queued",
      job: { job_id: "job-2", status: "queued" },
    });
  };

  await submitChatJob(
    { message: "Tell me more.", conversationId: "conv-1" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
});

test("submitChatJob gives compact code follow-ups a complete-code budget", async () => {
  const fetchImpl = async (url, init) => {
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [] });
    }
    if (url.includes("/v1/conversations/conv-code/messages") && (!init || init.method !== "POST")) {
      return jsonResponse({
        conversation_id: "conv-code",
        messages: [
          { role: "user", content: "Tell me a joke." },
          { role: "assistant", content: "Unrelated chat." },
          { role: "user", content: "Write a complete Java program." },
          { role: "assistant", content: "```java\nclass Main {}\n```" },
        ],
      });
    }
    if (url.includes("/v1/conversations/")) {
      return jsonResponse({ id: 1 }, true, 201);
    }
    const body = JSON.parse(init.body);
    assert.equal(body.execution_mode, "single");
    assert.equal(body.max_tokens, 1536);
    assert.match(body.system_prompt, /class Main/);
    assert.doesNotMatch(body.system_prompt, /Tell me a joke|Unrelated chat/);
    return jsonResponse({
      job_id: "job-code-follow-up",
      status: "queued",
      job: { job_id: "job-code-follow-up", status: "queued" },
    });
  };

  await submitChatJob(
    { message: "Now convert it to Rust.", conversationId: "conv-code" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );
});

test("submitChatJob does not fetch conversation history for tool paths", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/v1/conversations/")) {
      return jsonResponse({ id: 1 }, true, 201);
    }
    assert.equal(url, "https://wttr.in/Manila?format=j1");
    return jsonResponse({
      nearest_area: [
        {
          areaName: [{ value: "Manila" }],
          region: [{ value: "National Capital Region" }],
          country: [{ value: "Philippines" }],
        },
      ],
      current_condition: [
        {
          weatherDesc: [{ value: "Partly cloudy" }],
          temp_C: "31",
          temp_F: "88",
          FeelsLikeC: "36",
          FeelsLikeF: "97",
          humidity: "70",
          windspeedKmph: "12",
          localObsDateTime: "2026-07-03 05:00 PM",
        },
      ],
    });
  };

  const result = await submitChatJob(
    { message: "what is the weather in Manila today?", conversationId: "conv-1" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  const historyFetchCalls = calls.filter(
    (call) => call.url.includes("/v1/conversations/") && (!call.init || call.init.method !== "POST"),
  );
  assert.equal(historyFetchCalls.length, 0);
});

test("sync tool paths persist both the user and assistant turns", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === "https://wttr.in/Manila?format=j1") {
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Manila" }],
            region: [{ value: "National Capital Region" }],
            country: [{ value: "Philippines" }],
          },
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Partly cloudy" }],
            temp_C: "31",
            temp_F: "88",
            FeelsLikeC: "36",
            FeelsLikeF: "97",
            humidity: "70",
            windspeedKmph: "12",
            localObsDateTime: "2026-07-03 05:00 PM",
          },
        ],
      });
    }
    assert.ok(url.includes("/v1/conversations/conv-1/messages"));
    return jsonResponse({ id: 1 }, true, 201);
  };

  const result = await submitChatJob(
    { message: "what is the weather in Manila today?", conversationId: "conv-1" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  const messageCalls = calls.filter((call) => call.url.includes("/v1/conversations/conv-1/messages"));
  assert.equal(messageCalls.length, 2);
  assert.equal(JSON.parse(messageCalls[0].init.body).role, "user");
  const assistantBody = JSON.parse(messageCalls[1].init.body);
  assert.equal(assistantBody.role, "assistant");
  assert.equal(assistantBody.jobId, null);
  assert.equal(assistantBody.tool, "weather");
});

test("pollChatJob persists the assistant turn exactly once on completion", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/v1/conversations/")) {
      return jsonResponse({ id: 1 }, true, 201);
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs/job-1");
    return jsonResponse({
      job: {
        job_id: "job-1",
        status: "completed",
        model: "Qwen/Test",
        output: "llama.cpp mode=cuda; response=assistant: Done.",
      },
    });
  };

  await pollChatJob(
    "job-1",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
    { conversationId: "conv-1" },
  );

  const messageCalls = calls.filter((call) => call.url.includes("/v1/conversations/conv-1/messages"));
  assert.equal(messageCalls.length, 1);
  const body = JSON.parse(messageCalls[0].init.body);
  assert.equal(body.role, "assistant");
  assert.equal(body.content, "Done.");
  assert.equal(body.jobId, "job-1");
});

test("pollChatJob keeps deterministic cleanup while verifier is disabled", async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs/job-quality");
    return jsonResponse({
      job: {
        job_id: "job-quality",
        status: "completed",
        model: "Qwen/Test",
        output:
          "llama.cpp mode=cuda; response=MundusX code subjob: Name: Magic square Responsibility: implementation Required output: matrix. The program should take a 3x3 matrix as input, perform the magic square operation, and print the result. The program should take a 3x3 matrix as input, perform the magic square operation, and print the result. The program should take a 3x3 matrix as input, perform the magic square operation, and print the result.",
      },
    });
  };

  const result = await pollChatJob(
    "job-quality",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.needs_repair, false);
  assert.match(result.output, /explanation instead of source code/i);
  assert.deepEqual(result.quality_flags, []);
});

test("pollChatJob deterministically repairs safe Java output defects", async () => {
  const prompt = "Create a Java program where main calls a Fibonacci function.";
  const result = await pollChatJob(
    "job-java-repair",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () =>
      jsonResponse({
        job: {
          job_id: "job-java-repair",
          status: "completed",
          model: "Qwen/Test",
          output:
            "```java Scanner; public class FibonacciProgram { public static void main(String[] args) { Scanner scanner = new Scanner(System.in); print(\"Enter a number: \" ); println(fibonacci(scanner.nextInt())); } public static long fibonacci(int n) { return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2); } } ```",
        },
      }),
    { message: prompt },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.needs_repair, false);
  assert.match(result.output, /import java\.util\.Scanner;/);
  assert.match(result.output, /System\.out\.print\(/);
  assert.match(result.output, /System\.out\.println\(/);
  assert.match(result.output, /public class FibonacciProgram \{\n {4}public static void main/);
  assert.deepEqual(result.quality_flags, []);
});

test("pollChatJob rejects Java when main omits the requested Fibonacci method contract", async () => {
  const prompt = "Create a Java program with a main method that calls the Fibonacci function.";
  const result = await pollChatJob(
    "job-java-semantic-invalid",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => jsonResponse({
      job: {
        job_id: "job-java-semantic-invalid",
        status: "completed",
        output: "```java\npublic class FibonacciProgram { public static void main(String[] args) { int a = 0; int b = 1; System.out.println(a + b); } }\n```",
      },
    }),
    { message: prompt },
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /does not define the requested Fibonacci method/);
});

test("submitChatTurn retries one invalid complete-code result with stricter validation instructions", async () => {
  const prompts = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith("https://uat.mundusx.ai/v1/nodes")) {
      return jsonResponse({ items: [] });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    const body = JSON.parse(init.body);
    prompts.push(body.system_prompt);
    const retry = /internal validation retry/i.test(body.system_prompt);
    return jsonResponse({
      job_id: retry ? "job-retry-valid" : "job-first-invalid",
      job: {
        job_id: retry ? "job-retry-valid" : "job-first-invalid",
        status: "completed",
        output: retry
          ? "```java\npublic class FibonacciProgram { public static void main(String[] args) { System.out.println(fibonacci(8)); } public static long fibonacci(int n) { return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2); } }\n```"
          : "```java\npublic class FibonacciProgram { public static void main(String[] args) { System.out.println(8); } }\n```",
      },
    });
  };

  const result = await submitChatTurn(
    { message: "Create a Java program with a main method that calls the Fibonacci function." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0], /internal validation retry/i);
  assert.match(prompts[1], /internal validation retry/i);
  assert.equal(result.status, "completed");
  assert.match(result.output, /fibonacci\(8\)/);
});

test("submitChatTurn rejects and retries a truncated multi-file CRUD response", async () => {
  const prompts = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith("https://uat.mundusx.ai/v1/nodes")) return jsonResponse({ items: [] });
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    const body = JSON.parse(init.body);
    prompts.push(body.system_prompt);
    const retry = /internal validation retry/i.test(body.system_prompt);
    return jsonResponse({
      job_id: retry ? "job-crud-valid" : "job-crud-truncated",
      job: {
        job_id: retry ? "job-crud-valid" : "job-crud-truncated",
        status: "completed",
        output: retry
          ? "```javascript\nconst express = require('express'); const mysql = require('mysql2'); const app = express(); const db = mysql.createConnection({host: 'localhost'}); app.get('/orders', handler); app.post('/orders', handler); app.put('/orders/:id', handler); app.delete('/orders/:id', handler); app.listen(3000);\n```"
          : "Step 1:\n```sh\nnpm install express mysql2\n```\nStep 2:\n```javascript\nconst express = require('express'); const app = express(); app.get('/orders', handler); app.post('/orders', handler); app.put('/orders/:id', handler); app.delete('/orders/:id', handler);\n```\nStep 3:\n```javascript\nmodule.exports = { host: 'localhost',",
      },
    });
  };

  const result = await submitChatTurn(
    { message: "Give me example Node.js code using Express for an API that connects to MySQL and provides CRUD interfaces for order data." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /internal validation retry/i);
  assert.equal(result.status, "completed");
  assert.match(result.output, /app\.delete/);
});

test("submitChatTurn retries malformed math output before completing", async () => {
  const prompts = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith("https://uat.mundusx.ai/v1/nodes")) {
      return jsonResponse({ items: [] });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    const body = JSON.parse(init.body);
    prompts.push(body.system_prompt);
    const retry = /internal validation retry/i.test(body.system_prompt);
    return jsonResponse({
      job_id: retry ? "job-math-retry-valid" : "job-math-first-invalid",
      job: {
        job_id: retry ? "job-math-retry-valid" : "job-math-first-invalid",
        status: "completed",
        output: retry
          ? "Answer: 60 degrees. The triangle angle sum is 180 degrees, so x = 180 - 80 - 40 = 60 degrees."
          : "Using the triangle angle sum: \\[ x = 180 - 80 - 40 \\] \\[ \\]",
      },
    });
  };

  const result = await submitChatTurn(
    { message: "Determine angle x when the other triangle angles are 80 and 40 degrees." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /internal validation retry/i);
  assert.equal(result.status, "completed");
  assert.match(result.output, /60 degrees/);
});

test("OpenAI adapter retries malformed requested JSON before completing", async () => {
  let attempts = 0;
  const result = await submitOpenAiChatCompletion(
    {
      messages: [{ role: "user", content: "Return the customer record." }],
      response_format: { type: "json_object" },
    },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url, init = {}) => {
      if (url.startsWith("https://uat.mundusx.ai/v1/nodes")) return jsonResponse({ items: [] });
      assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
      attempts += 1;
      return jsonResponse({
        job_id: `job-json-${attempts}`,
        job: {
          job_id: `job-json-${attempts}`,
          status: "completed",
          output: attempts === 1 ? '{"name":"Ada"' : '{"name":"Ada"}',
        },
      });
    },
  );
  assert.equal(attempts, 2);
  assert.deepEqual(JSON.parse(result.choices[0].message.content), { name: "Ada" });
});

test("pollChatJob rejects a repeated prose loop after a valid fenced Java program", async () => {
  const result = await pollChatJob(
    "job-java-repetition-loop",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => jsonResponse({
      job: {
        job_id: "job-java-repetition-loop",
        status: "completed",
        output: "```java\npublic class FibonacciProgram { public static void main(String[] args) { System.out.println(fibonacci(8)); } public static long fibonacci(int n) { return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2); } }\n```\nIn this code, the `main` method calls `main` method calls `main` method calls `main` method calls `main` method calls `main` method calls.",
      },
    }),
    { message: "Create a Java program with a main method that calls the Fibonacci function." },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.output, "");
  assert.match(result.error, /repeated text loop/i);
  assert.ok(result.quality_flags.some((flag) => flag.code === "degenerate_repetition"));
});

test("pollChatJob cleans repeated prose after fenced code without changing the code", async () => {
  const explanation = "The main method calls fibonacci and prints the result.";
  const result = await pollChatJob(
    "job-java-repeated-explanation",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => jsonResponse({
      job: {
        job_id: "job-java-repeated-explanation",
        status: "completed",
        output: `\`\`\`java\npublic class FibonacciProgram { public static void main(String[] args) { System.out.println(fibonacci(8)); } public static long fibonacci(int n) { return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2); } }\n\`\`\`\n${explanation} ${explanation} ${explanation}`,
      },
    }),
    { message: "Create a Java program with a main method that calls the Fibonacci function." },
  );

  assert.equal(result.status, "completed");
  assert.match(result.output, /System\.out\.println\(fibonacci\(8\)\);/);
  assert.equal(result.output.match(/The main method calls fibonacci and prints the result\./g)?.length, 1);
  assert.deepEqual(result.quality_flags, []);
});

test("submitChatTurn retries a repeated prose loop and returns only the validated answer", async () => {
  const prompts = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith("https://uat.mundusx.ai/v1/nodes")) {
      return jsonResponse({ items: [] });
    }
    const body = JSON.parse(init.body);
    prompts.push(body.system_prompt);
    const retry = /internal validation retry/i.test(body.system_prompt);
    return jsonResponse({
      job_id: retry ? "job-repetition-retry-valid" : "job-repetition-first-invalid",
      job: {
        job_id: retry ? "job-repetition-retry-valid" : "job-repetition-first-invalid",
        status: "completed",
        output: retry
          ? "```java\npublic class FibonacciProgram { public static void main(String[] args) { System.out.println(fibonacci(8)); } public static long fibonacci(int n) { return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2); } }\n```\nThe main method calls fibonacci and prints the result."
          : "```java\npublic class FibonacciProgram { public static void main(String[] args) { System.out.println(fibonacci(8)); } public static long fibonacci(int n) { return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2); } }\n```\nThe `main` method calls `main` method calls `main` method calls `main` method calls `main` method calls `main` method calls.",
      },
    });
  };

  const result = await submitChatTurn(
    { message: "Create a Java program with a main method that calls the Fibonacci function." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Do not repeat words, clauses, sentences, or sections/);
  assert.equal(result.status, "completed");
  assert.doesNotMatch(result.output, /main method calls main method calls/i);
  assert.deepEqual(result.quality_flags, []);
});

test("pollChatJob rejects Java that remains structurally invalid after normalization", async () => {
  const prompt = "Create a Java program where main calls a Fibonacci function.";
  const result = await pollChatJob(
    "job-java-invalid",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () =>
      jsonResponse({
        job: {
          job_id: "job-java-invalid",
          status: "completed",
          model: "Qwen/Test",
          output: "```java\npublic class FibonacciProgram { public static long fibonacci(int n) { return n; }\n```",
        },
      }),
    { message: prompt },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.output, "");
  assert.match(result.error, /does not define public static void main|unbalanced Java delimiters/);
  assert.ok(result.quality_flags.some((flag) => flag.code === "invalid_complete_code"));
});

test("pollChatJob rejects incomplete Python and C++ runnable programs", async () => {
  const cases = [
    {
      id: "python",
      prompt: "Create a complete runnable Python program with a main function.",
      output: "```python\ndef fibonacci(n):\n    return n if n < 2 else fibonacci(n - 1) + fibonacci(n - 2)\n```",
      error: /Python main entrypoint/,
    },
    {
      id: "cpp",
      prompt: "Create a complete runnable C++ program with main.",
      output: "```cpp\nint main() { std::cout << 1; }\n```",
      error: /including iostream/,
    },
  ];

  for (const testCase of cases) {
    const result = await pollChatJob(
      `job-${testCase.id}-invalid`,
      configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
      async () => jsonResponse({
        job: {
          job_id: `job-${testCase.id}-invalid`,
          status: "completed",
          output: testCase.output,
        },
      }),
      { message: testCase.prompt },
    );
    assert.equal(result.status, "failed");
    assert.match(result.error, testCase.error);
  }
});

test("pollChatJob accepts structurally complete Python and Go programs", async () => {
  const cases = [
    {
      id: "python",
      prompt: "Create a complete runnable Python program with a main function.",
      output: "```python\ndef main():\n    print('hello')\n\nif __name__ == '__main__':\n    main()\n```",
    },
    {
      id: "go",
      prompt: "Create a complete runnable Go program with main.",
      output: "```go\npackage main\n\nimport \"fmt\"\n\nfunc main() { fmt.Println(\"hello\") }\n```",
    },
  ];

  for (const testCase of cases) {
    const result = await pollChatJob(
      `job-${testCase.id}-valid`,
      configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
      async () => jsonResponse({
        job: {
          job_id: `job-${testCase.id}-valid`,
          status: "completed",
          output: testCase.output,
        },
      }),
      { message: testCase.prompt },
    );
    assert.equal(result.status, "completed");
    assert.deepEqual(result.quality_flags, []);
  }
});

test("pollChatJob does not reject restated intent while verifier is disabled", async () => {
  const prompt = "How can we begin creating a conversation with context on, and with compacting context as well?";
  const fetchImpl = async (url) => {
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs/job-restated-intent");
    return jsonResponse({
      job: {
        job_id: "job-restated-intent",
        status: "completed",
        model: "Qwen/Test",
        output:
          "I am looking for a way to create a conversation that has context and context compression. I want to be able to start a conversation and have it flow naturally while also being able to compress the context as the conversation progresses. I want to be able to start a conversation and have it flow naturally while also be able to compress the context as the conversation progresses.",
      },
    });
  };

  const result = await pollChatJob(
    "job-restated-intent",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
    { message: prompt },
  );

  assert.equal(result.status, "completed");
  assert.match(result.output, /conversation that has context/i);
  assert.deepEqual(result.quality_flags, []);
});

test("pollChatJob allows self-evaluation answers that reuse prompt terms", async () => {
  const prompt = "what do u think of rentakoto.com ? is it a good ui/ux ? give me you detailed self evaluation";
  const fetchImpl = async (url) => {
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs/job-ui-eval");
    return jsonResponse({
      job: {
        job_id: "job-ui-eval",
        status: "completed",
        model: "Qwen/Test",
        output:
          "I need to evaluate Rentakoto.com across UI clarity, UX flow, visual hierarchy, mobile responsiveness, trust signals, and conversion friction. The strongest path is to review the homepage, booking flow, and support pages, then score each area with concrete recommendations.",
      },
    });
  };

  const result = await pollChatJob(
    "job-ui-eval",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
    { message: prompt },
  );

  assert.equal(result.status, "completed");
  assert.match(result.output, /evaluate Rentakoto\.com/);
  assert.ok(!result.quality_flags.some((flag) => flag.code === "prompt_restatement"));
});

test("pollChatJob does not persist a turn for a non-completed job", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse({ job: { job_id: "job-1", status: "queued" } });
  };

  await pollChatJob(
    "job-1",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
    { conversationId: "conv-1" },
  );

  assert.ok(!calls.some((url) => url.includes("/v1/conversations/")));
});

test("pollChatJob does not persist a turn without a conversationId", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse({
      job: { job_id: "job-1", status: "completed", output: "Done." },
    });
  };

  await pollChatJob(
    "job-1",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.ok(!calls.some((url) => url.includes("/v1/conversations/")));
});

test("conversation-memory write failures never break submitChatJob's response", async () => {
  const fetchImpl = async (url) => {
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [] });
    }
    if (url.includes("/v1/conversations/")) {
      return jsonResponse({ error: "boom" }, false, 500);
    }
    return jsonResponse({
      job_id: "job-1",
      status: "queued",
      job: { job_id: "job-1", status: "queued" },
    });
  };

  const result = await submitChatJob(
    { message: "hello", conversationId: "conv-1" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.job_id, "job-1");
  assert.equal(result.status, "queued");
});

test("conversation-memory read failures never break submitChatJob's response", async () => {
  const fetchImpl = async (url, init) => {
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [] });
    }
    if (url.includes("/v1/conversations/conv-1/messages") && (!init || init.method !== "POST")) {
      return jsonResponse({ error: "boom" }, false, 500);
    }
    if (url.includes("/v1/conversations/")) {
      return jsonResponse({ id: 1 }, true, 201);
    }
    return jsonResponse({
      job_id: "job-1",
      status: "queued",
      job: { job_id: "job-1", status: "queued" },
    });
  };

  const result = await submitChatJob(
    { message: "hello", conversationId: "conv-1" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.job_id, "job-1");
  assert.equal(result.status, "queued");
});

test("conversation-memory write failures never break pollChatJob's response", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/v1/conversations/")) {
      return jsonResponse({ error: "boom" }, false, 500);
    }
    return jsonResponse({
      job: { job_id: "job-1", status: "completed", output: "Done." },
    });
  };

  const result = await pollChatJob(
    "job-1",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
    { conversationId: "conv-1" },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, "Done.");
});

test("deleteChatConversation proxies real conversation deletion to the control plane", async () => {
  const calls = [];
  const result = await deleteChatConversation(
    "conv-1",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url, init) => {
      calls.push({ url, init });
      assert.equal(url, "https://uat.mundusx.ai/v1/conversations/conv-1");
      assert.equal(init.method, "DELETE");
      return jsonResponse({ conversation_id: "conv-1", deleted: true, persisted: true });
    },
  );

  assert.deepEqual(result, { conversation_id: "conv-1", deleted: true, persisted: true });
  assert.equal(calls.length, 1);
});

test("fetchChatConversation proxies persisted conversation messages from the control plane", async () => {
  const result = await fetchChatConversation(
    "conv-1",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url, init) => {
      assert.equal(url, "https://uat.mundusx.ai/v1/conversations/conv-1/messages?limit=80");
      assert.equal(init.method, undefined);
      return jsonResponse({
        conversation_id: "conv-1",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      });
    },
  );

  assert.equal(result.conversation_id, "conv-1");
  assert.equal(result.persisted, true);
  assert.deepEqual(result.messages.map((message) => message.content), ["hello", "hi"]);
});

test("fetchChatConversation treats missing chat storage as an empty shallow conversation", async () => {
  const result = await fetchChatConversation(
    "conv-1",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => jsonResponse({ error: "supabase table missing" }, false, 502),
  );

  assert.equal(result.conversation_id, "conv-1");
  assert.equal(result.persisted, false);
  assert.deepEqual(result.messages, []);
});

test("deleteChatConversation treats missing backend records as shallow local history", async () => {
  const result = await deleteChatConversation(
    "tool-only",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async () => jsonResponse({ error: "not found" }, false, 404),
  );

  assert.equal(result.conversation_id, "tool-only");
  assert.equal(result.deleted, false);
  assert.equal(result.persisted, false);
});

test("extracts a location that comes before the word weather", () => {
  // "Whats the berlin weather today?" previously found nothing: the patterns
  // only look after "weather", so they saw "today" and rejected it.
  assert.equal(extractWeatherLocation("Whats the berlin weather today?"), "berlin");
  assert.equal(extractWeatherLocation("the manila weather"), "manila");
  assert.equal(extractWeatherLocation("Berlin temperature right now"), "Berlin");
  assert.equal(extractWeatherLocation("new york city weather today"), "new york city");
});

test("does not invent a location from words that are not places", () => {
  assert.equal(extractWeatherLocation("is the weather nice"), null);
  assert.equal(extractWeatherLocation("what's the weather"), null);
  assert.equal(extractWeatherLocation("how is the weather today"), null);
  assert.equal(extractWeatherLocation("show me the current weather"), null);
  assert.equal(extractWeatherLocation("tell me the weather"), null);
});

test("does not route weather resource recommendations as live conditions", () => {
  const recommendation = "Can you recommend any weather-related websites or apps for New Zealand?";
  assert.equal(isWeatherResourceRequest(recommendation), true);
  assert.equal(extractWeatherLocation(recommendation), null);
  assert.equal(isWeatherResourceRequest("What is the weather in New Zealand?"), false);
  assert.equal(extractWeatherLocation("What is the weather in New Zealand?"), "New Zealand");
});

test("still prefers the explicit location that follows weather", () => {
  assert.equal(extractWeatherLocation("weather in Berlin"), "Berlin");
  assert.equal(extractWeatherLocation("what is the weather in Manila today?"), "Manila");
  assert.equal(extractWeatherLocation("forecast for Tokyo"), "Tokyo");
  assert.equal(extractWeatherLocation("Weather is stuttgart tomorrow?"), "stuttgart");
  assert.equal(extractWeatherLocation("Weather will be in Munich the day after tomorrow"), "Munich");
  assert.equal(extractWeatherDayOffset("Weather is Stuttgart tomorrow?"), 1);
  assert.equal(extractWeatherDayOffset("Munich weather the day after tomorrow"), 2);
  assert.equal(extractWeatherDayOffset("Weather in Berlin today"), 0);
});

test("tolerates misspelled weather words", () => {
  assert.equal(extractWeatherLocation("wheather in Berlin"), "Berlin");
  assert.equal(extractWeatherLocation("whats the berlin wheather today?"), "berlin");
  assert.equal(extractWeatherLocation("weater in Manila"), "Manila");
  assert.equal(extractWeatherLocation("forcast for Tokyo"), "Tokyo");
  assert.equal(extractWeatherLocation("temprature in Paris"), "Paris");
});

test("normalizeWeatherWordTypos leaves correct spellings alone", () => {
  assert.equal(normalizeWeatherWordTypos("weather in Berlin"), "weather in Berlin");
  assert.equal(normalizeWeatherWordTypos("wheather"), "weather");
  assert.equal(normalizeWeatherWordTypos(""), "");
});

test("a question with no weather intent is still ignored", () => {
  assert.equal(extractWeatherLocation("who is Ada Lovelace"), null);
  assert.equal(extractWeatherLocation(""), null);
  assert.equal(extractWeatherLocation(null), null);
});
