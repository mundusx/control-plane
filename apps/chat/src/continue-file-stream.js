import { randomUUID } from "node:crypto";

// Continue's system-message tool parser buffers whole arguments. Adapt only its
// explicit file-creation protocol; ordinary chats and native tools stay untouched.
export function usesContinueFileProtocol(body) {
  if (body?.tools?.length) return false;
  return body?.messages?.some(message => message?.role === "system" &&
    typeof message.content === "string" && message.content.includes("<tool_use_instructions>") &&
    message.content.includes("BEGIN_ARG: contents") && message.content.includes("TOOL_NAME: create_new_file"));
}

export class ContinueFileStream {
  buffer = "";
  state = "text";
  header = "";
  converted = false;
  index = -1;
  argCount = 0;
  fields = new Set();
  argName = "";
  argText = "";
  encoded = "";
  preview = null;

  tool(argumentsPart, name) {
    return { tool_calls: [{ index: this.index, ...(name ? {
      id: `call_${randomUUID().replaceAll("-", "")}`, type: "function",
    } : {}), function: { ...(name ? { name } : {}), arguments: argumentsPart } }] };
  }

  push(text) {
    this.buffer += text;
    const output = [];
    let end;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end + 1);
      this.buffer = this.buffer.slice(end + 1);
      output.push(...this.line(line));
    }
    // Preserve ordinary answer streaming while holding a possible tool fence.
    if (this.state === "text" && this.buffer &&
      !"```tool".startsWith(this.buffer.trim()) && !this.buffer.trimStart().startsWith("```tool")) {
      output.push({ content: this.buffer }); this.buffer = "";
    }
    return output;
  }

  line(line) {
    const trimmed = line.trim();
    if (this.state === "text") {
      if (trimmed === "```tool") { this.header = line; this.state = "header"; return []; }
      return [{ content: line }];
    }
    if (this.state === "header") {
      if (/^TOOL_NAME:\s*create_new_file$/i.test(trimmed)) {
        this.state = "tool"; this.converted = true; this.index++; this.argCount = 0; this.fields.clear();
        return [this.tool("{", "create_new_file")];
      }
      this.state = "passthrough";
      return [{ content: this.header + line }];
    }
    if (this.state === "passthrough") {
      if (trimmed === "```") this.state = "text";
      return [{ content: line }];
    }
    if (this.state === "tool") {
      if (trimmed === "```") {
        if (!this.fields.has("filepath") || !this.fields.has("contents")) throw new Error("Incomplete file tool arguments");
        this.state = "text"; return [this.tool("}")];
      }
      if (!trimmed) return [];
      const match = /^BEGIN_ARG:\s*(filepath|contents)$/i.exec(trimmed);
      if (!match) throw new Error("Invalid streamed file argument");
      this.argName = match[1].toLowerCase();
      if (this.fields.has(this.argName)) throw new Error("Duplicate file tool argument");
      this.fields.add(this.argName); this.argText = ""; this.encoded = ""; this.preview = null;
      this.state = "arg";
      return [this.tool(`${this.argCount++ ? "," : ""}${JSON.stringify(this.argName)}:`)];
    }
    if (trimmed === "END_ARG") {
      const value = this.argText.trim();
      let encoded;
      if (this.preview) encoded = JSON.stringify(value);
      else { let parsed = value; try { parsed = JSON.parse(value); } catch {} encoded = JSON.stringify(parsed); }
      if (!encoded.startsWith(this.encoded)) throw new Error("File argument stream prefix mismatch");
      this.state = "tool";
      return [this.tool(encoded.slice(this.encoded.length))];
    }
    this.argText += line;
    const value = this.argText.trim();
    if (this.argName !== "contents" || !value) return [];
    if (this.preview === null) this.preview = !/^(?:["[{]|-?\d|true\b|false\b|null\b)/.test(value);
    if (!this.preview) return [];
    const encoded = JSON.stringify(value).slice(0, -1);
    if (!encoded.startsWith(this.encoded)) throw new Error("File contents stream prefix mismatch");
    const part = encoded.slice(this.encoded.length); this.encoded = encoded;
    return part ? [this.tool(part)] : [];
  }

  finish() {
    const output = this.buffer ? this.line(this.buffer) : [];
    this.buffer = "";
    if (this.state !== "text" && this.state !== "passthrough") throw new Error("File tool stream ended before completion");
    return output;
  }
}
