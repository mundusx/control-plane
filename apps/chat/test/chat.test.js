import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanChatOutput,
  configFromEnv,
  escapeHtml,
  extractCurrentOfficeQuery,
  extractFactualSummaryTopic,
  extractGeneralLookupTopic,
  extractLinearEquation,
  extractPolynomialDerivative,
  extractPolynomialIntegral,
  extractWeatherLocation,
  fetchNetworkSummary,
  needsGrounding,
  page,
  pollChatJob,
  submitChatJob,
  submitChatTurn,
} from "../src/main.js";

test("renders a usable chat page", () => {
  const html = page(
    configFromEnv({
      MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai/",
      MUNDUSX_CHAT_TIMEOUT_SECONDS: "45",
    }),
  );

  assert.match(html, /MundusX Chat/);
  assert.match(html, /Welcome to[\s\S]*MundusX[\s\S]*Chat/);
  assert.match(html, /id="chat-form"/);
  assert.match(html, /id="voice-mic"/);
  assert.match(html, /id="voice-speak"/);
  assert.match(html, /id="voice-status"/);
  assert.match(html, /SpeechRecognition/);
  assert.match(html, /speechSynthesis/);
  assert.match(html, /getUserMedia/);
  assert.match(html, /recognition\.continuous = true/);
  assert.match(html, /const silenceTimeoutMs = 4000/);
  assert.match(html, /const hardStopTimeoutMs = 60000/);
  assert.match(html, /transcriptParts\.join\(" "\)/);
  assert.match(html, /No speech heard/);
  assert.match(html, /Voice limit reached/);
  assert.match(html, /Transcript ready/);
  assert.match(html, /function speakAssistantReply/);
  assert.match(html, /function selectSpokenVoice/);
  assert.match(html, /function selectAtlasVoice/);
  assert.match(html, /function selectedAssistantPersona/);
  assert.match(html, /Microsoft David/);
  assert.match(html, /Speaking with Atlas/);
  assert.doesNotMatch(html, /id="voice-select"/);
  assert.doesNotMatch(html, /Auto voice/);
  assert.match(html, /id="history-list"/);
  assert.match(html, /id="network-state"/);
  assert.match(html, /\.work-trace/);
  assert.match(html, /Completed source sections/);
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
  assert.match(html, /\.citation-sources/);
  assert.match(html, /\.tool-badge/);
  assert.match(html, /\.message\.assistant \.message-body/);
  assert.match(html, /\.message\.user \.message-body/);
  assert.match(html, /\.code-block/);
  assert.match(html, /function stripEchoedPrompt/);
  assert.match(html, /function appendRichMessage/);
  assert.match(html, /function normalizeAssistantDisplayText/);
  assert.match(html, /function appendInlineMarkdown/);
  assert.match(html, /function formatCodeForDisplay/);
  assert.match(html, /function shouldShowSourceSections/);
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
  assert.match(html, /\.history-title \{/);
  assert.match(html, /row\.innerHTML = "<span class='history-title'><\/span><span class='history-time'><\/span>"/);
  assert.match(html, /\.rail-list \{[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;/);
  assert.match(html, /\.history-item \{[\s\S]*?overflow: hidden;/);
  assert.match(html, /\.history-time \{[\s\S]*?text-overflow: ellipsis;/);
  assert.match(html, /html \{[\s\S]*?overflow-x: hidden;/);
  assert.match(html, /\.messages \{[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;/);
  assert.match(html, /\.conversation \{[\s\S]*?min-width: 0;/);
  assert.match(html, /\.message \{[\s\S]*?min-width: 0;/);
  assert.match(html, /\.code-block \{[\s\S]*?max-width: 100%;[\s\S]*?min-width: 0;/);
  assert.match(html, /\.code-block pre \{[\s\S]*?white-space: pre-wrap;[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(html, /\.code-block code \{[\s\S]*?white-space: inherit;[\s\S]*?overflow-wrap: inherit;/);
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
    assert.match(body.system_prompt, /My name is \*\*Atlas\*\*/);
    assert.match(body.system_prompt, /Do not echo persona notes/);
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

test("uses Atlas persona for male voice chat jobs", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.prompt, "Explain MundusX in one paragraph.");
    assert.match(body.system_prompt, /You are Atlas/);
    assert.match(body.system_prompt, /the MundusX assistant/);
    assert.match(body.system_prompt, /My name is \*\*Atlas\*\*/);
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

  assert.equal(calls[0].max_tokens, 4096);
  assert.equal(calls[1].max_tokens, 4096);
  assert.match(calls[1].system_prompt, /complete compilable source file/i);
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
  assert.match(result.output, /^I'm Atlas, the MundusX assistant\./);
  assert.match(result.output, /troubleshoot nodes and jobs/i);
  assert.doesNotMatch(result.output, /I'm a new user|Can you tell me|valuable resource/i);
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

test("does not let one direct tool hijack a compound chat prompt", async () => {
  const calls = [];
  const prompt =
    "Hey Atlas kindly introduce yourself and let me know what is the weather today in Newfing Germany and then tell me who is David Battalia";
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.notEqual(url, "https://wttr.in/Newfing%20Germany?format=j1");
    if (url === "https://uat.mundusx.ai/v1/nodes?page=1&page_size=25") {
      return jsonResponse({ items: [] });
    }
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    const body = JSON.parse(init.body);
    assert.equal(body.prompt, prompt);
    return jsonResponse({
      job_id: "compound-1",
      status: "queued",
      job: {
        job_id: "compound-1",
        status: "queued",
        model: "Qwen/Test",
        execution_mode: "auto",
        graph_execution_enabled: false,
        plan: { strategy: "single_job" },
      },
    });
  };

  const result = await submitChatJob(
    { message: prompt },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "queued");
  assert.equal(result.execution_mode, "auto");
  assert.equal(result.job_id, "compound-1");
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://uat.mundusx.ai/v1/nodes?page=1&page_size=25", "https://uat.mundusx.ai/v1/jobs"],
  );
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

test("extracts only factual summary topics", () => {
  assert.equal(extractFactualSummaryTopic("Give me a detailed history of BMW from its origins to today."), "BMW");
  assert.equal(extractFactualSummaryTopic("Who is Ada Lovelace?"), "Ada Lovelace");
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

test("returns a user-facing fallback for empty cleaned responses", () => {
  assert.equal(
    cleanChatOutput("llama.cpp mode=cuda; response=system:"),
    "MundusX returned an empty response. Please try again.",
  );
});
