const { randomUUID } = require("node:crypto");
function toChat(body) {
  const fail = (message) => {
    throw Object.assign(Error(message), { status: 400 });
  };
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    fail("stream must be boolean");
  if (body.text?.format && body.text.format.type !== "text")
    fail(
      "Structured output formats are not supported by the current public router",
    );
  if (
    body.previous_response_id ||
    body.conversation ||
    body.background ||
    body.store === true
  )
    fail(
      "Stateful Responses are not supported; send the complete input history with store:false",
    );
  if (typeof body.model !== "string" || !body.model.trim())
    fail("model is required");
  const messages = [];
  if (body.instructions)
    messages.push({ role: "developer", content: body.instructions });
  const input =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : body.input;
  if (!Array.isArray(input) || !input.length)
    fail("input must be a string or nonempty array");
  for (const item of input) {
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: item.arguments },
          },
        ],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content:
          typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output),
      });
      continue;
    }
    if (item.type && item.type !== "message")
      fail("Unsupported input item type: " + item.type);
    const content = Array.isArray(item.content)
      ? item.content.map((part) => {
          if (["input_text", "output_text", "text"].includes(part.type))
            return { type: "text", text: part.text };
          if (part.type === "input_image")
            return {
              type: "image_url",
              image_url: {
                url: part.image_url,
                ...(part.detail ? { detail: part.detail } : {}),
              },
            };
          fail("Unsupported input content type: " + part.type);
        })
      : item.content;
    if (!["user", "assistant", "system", "developer"].includes(item.role))
      fail("Unsupported input role");
    messages.push({ role: item.role, content });
  }
  const chat = { model: body.model, messages, stream: body.stream === true };
  for (const k of [
    "temperature",
    "top_p",
    "parallel_tool_calls",
    "user",
    "seed",
  ])
    if (body[k] !== undefined) chat[k] = body[k];
  if (body.max_output_tokens !== undefined)
    chat.max_tokens = body.max_output_tokens;
  if (body.reasoning?.effort) chat.reasoning_effort = body.reasoning.effort;
  if (body.tools) {
    if (
      !Array.isArray(body.tools) ||
      body.tools.some((t) => t.type !== "function")
    )
      fail("Only function tools are supported");
    chat.tools = body.tools.map(({ type, ...f }) => ({ type, function: f }));
  }
  if (body.tool_choice) {
    if (
      typeof body.tool_choice !== "string" &&
      (body.tool_choice.type !== "function" ||
        typeof body.tool_choice.name !== "string")
    )
      fail("Unsupported tool choice");
    chat.tool_choice =
      typeof body.tool_choice === "string"
        ? body.tool_choice
        : { type: "function", function: { name: body.tool_choice.name } };
  }
  const format = body.text?.format;
  if (format) {
    if (format.type === "json_schema") {
      const { type, ...schema } = format;
      chat.response_format = { type, json_schema: schema };
    } else chat.response_format = format;
  }
  if (chat.stream) chat.stream_options = { include_usage: true };
  return chat;
}
function responseObject(id, model, output, usage = {}, finish = "stop") {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: finish === "length" ? "incomplete" : "completed",
    error: null,
    incomplete_details:
      finish === "length" ? { reason: "max_output_tokens" } : null,
    model,
    output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    store: false,
    usage: [
      usage.prompt_tokens,
      usage.completion_tokens,
      usage.total_tokens,
    ].every((n) => Number.isSafeInteger(n) && n >= 0)
      ? {
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          input_tokens_details: {
            cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
          },
          output_tokens_details: {
            reasoning_tokens:
              usage.completion_tokens_details?.reasoning_tokens || 0,
          },
        }
      : null,
  };
}
function responsesHandler({
  upstream,
  token,
  agent,
  transport,
  error,
  defaults,
  prepareContext = body => body,
}) {
  return async (req, res, body) => {
    const chat = defaults(prepareContext(toChat(body), req, res)),
      id = "resp_" + randomUUID().replaceAll("-", "");
    const encoded = JSON.stringify(chat);
    const target = new URL(upstream);
    target.pathname =
      upstream.pathname.replace(/\/$/, "") + "/v1/chat/completions";
    const headers = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(encoded),
    };
    if (token) headers.authorization = "Bearer " + token;
    await new Promise((resolve) => {
      const pending = transport.request(
        target,
        { method: "POST", headers, agent },
        async (up) => {
          try {
            if ((up.statusCode || 500) >= 400) {
              res.writeHead(up.statusCode, {
                "Content-Type": "application/json",
              });
              up.pipe(res);
              up.on("end", resolve);
              return;
            }
            if (!chat.stream) {
              let text = "";
              for await (const c of up) {
                text += c;
                if (text.length > 32 * 1024 * 1024)
                  throw Error("Response too large");
              }
              const value = JSON.parse(text),
                message = value.choices?.[0]?.message || {},
                output = [];
              if (message.content)
                output.push({
                  id: "msg_" + randomUUID(),
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: message.content,
                      annotations: [],
                    },
                  ],
                });
              for (const call of message.tool_calls || [])
                output.push({
                  id: "fc_" + randomUUID(),
                  type: "function_call",
                  status: "completed",
                  call_id: call.id,
                  name: call.function.name,
                  arguments: call.function.arguments,
                });
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
              });
              res.end(
                JSON.stringify(
                  responseObject(
                    id,
                    body.model,
                    output,
                    value.usage,
                    value.choices?.[0]?.finish_reason,
                  ),
                ),
              );
              resolve();
              return;
            }
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
              "X-Accel-Buffering": "no",
            });
            res.flushHeaders();
            let seq = 0,
              buffer = "",
              usage = {},
              finish = "stop",
              message = null,
              finished = false;
            const output = [],
              calls = new Map(),
              decoder = new TextDecoder();
            const emit = (type, data) => {
              if (!res.destroyed)
                res.write(
                  "event: " +
                    type +
                    "\ndata: " +
                    JSON.stringify({ type, sequence_number: seq++, ...data }) +
                    "\n\n",
                );
            };
            const initial = responseObject(id, body.model, []);
            initial.status = "in_progress";
            initial.usage = null;
            emit("response.created", { response: initial });
            emit("response.in_progress", { response: initial });
            function chunk(value) {
              if (value.usage) usage = value.usage;
              for (const choice of value.choices || []) {
                if (choice.index && choice.index !== 0) continue;
                if (choice.finish_reason) {
                  finish = choice.finish_reason;
                  finished = true;
                }
                const delta = choice.delta || {};
                if (typeof delta.content === "string" && delta.content) {
                  if (!message) {
                    message = {
                      id: "msg_" + randomUUID(),
                      type: "message",
                      status: "in_progress",
                      role: "assistant",
                      content: [
                        { type: "output_text", text: "", annotations: [] },
                      ],
                    };
                    output.push(message);
                    emit("response.output_item.added", {
                      output_index: output.length - 1,
                      item: { ...message, content: [] },
                    });
                    emit("response.content_part.added", {
                      item_id: message.id,
                      output_index: output.indexOf(message),
                      content_index: 0,
                      part: { type: "output_text", text: "", annotations: [] },
                    });
                  }
                  message.content[0].text += delta.content;
                  emit("response.output_text.delta", {
                    item_id: message.id,
                    output_index: output.indexOf(message),
                    content_index: 0,
                    delta: delta.content,
                  });
                }
                for (const call of delta.tool_calls || []) {
                  let item = calls.get(call.index);
                  if (!item) {
                    item = {
                      id: "fc_" + randomUUID(),
                      type: "function_call",
                      status: "in_progress",
                      call_id: call.id || "call_" + randomUUID(),
                      name: call.function?.name || "",
                      arguments: "",
                    };
                    calls.set(call.index, item);
                    output.push(item);
                    emit("response.output_item.added", {
                      output_index: output.length - 1,
                      item: { ...item },
                    });
                  } else if (call.function?.name)
                    item.name += call.function.name;
                  if (call.function?.arguments) {
                    item.arguments += call.function.arguments;
                    emit("response.function_call_arguments.delta", {
                      item_id: item.id,
                      output_index: output.indexOf(item),
                      delta: call.function.arguments,
                    });
                  }
                }
              }
            }
            for await (const data of up) {
              buffer += decoder.decode(data, { stream: true });
              let boundary;
              while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
                const payload = frame
                  .split(/\r?\n/)
                  .filter((x) => x.startsWith("data:"))
                  .map((x) => x.slice(5).trimStart())
                  .join("\n");
                if (payload === "[DONE]") finished = true;
                else if (payload) chunk(JSON.parse(payload));
              }
            }
            if (!finished)
              throw Error("Upstream stream ended before completion");
            for (const item of output) {
              item.status = "completed";
              const output_index = output.indexOf(item);
              if (item.type === "message") {
                emit("response.output_text.done", {
                  item_id: item.id,
                  output_index,
                  content_index: 0,
                  text: item.content[0].text,
                });
                emit("response.content_part.done", {
                  item_id: item.id,
                  output_index,
                  content_index: 0,
                  part: item.content[0],
                });
              } else
                emit("response.function_call_arguments.done", {
                  item_id: item.id,
                  output_index,
                  name: item.name,
                  arguments: item.arguments,
                });
              emit("response.output_item.done", { output_index, item });
            }
            const result = responseObject(
              id,
              body.model,
              output,
              usage,
              finish,
            );
            emit(
              finish === "length"
                ? "response.incomplete"
                : "response.completed",
              { response: result },
            );
            res.end();
            resolve();
          } catch (e) {
            error(res, 502, "Invalid upstream inference response", "api_error");
            resolve();
          }
        },
      );
      pending.on("error", () => {
        error(res, 502, "Inference backend unavailable", "api_error");
        resolve();
      });
      pending.setTimeout(600000, () => pending.destroy());
      res.on("close", () => {
        pending.destroy();
        resolve();
      });
      pending.end(encoded);
    });
  };
}
module.exports = { responsesHandler, toChat, responseObject };
