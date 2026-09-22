// Public website questions work independently of local Projects and device state.
export function webResearchRequest(message, history = []) {
  const text = String(message || "").trim();
  if (!text || /\b(?:do not|don't|without|no)\s+(?:browse|browsing|search|searching|web access)\b/i.test(text)) return null;
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  const urls = [...new Set((prose.match(/https?:\/\/[^\s<>"']+/gi) || []).map(url => url.replace(/[),.;!?]+$/, "")))].slice(0, 4);
  const inspection = /\b(?:read|summari[sz]e|review|inspect|analy[sz]e|evaluate|visit|check|compare|tell|explain|learn|offer|pricing|features|about)\b/i.test(prose);
  const codeExample = /\b(?:write|generate|implement|example|sample|regex|parse|validate|mock|unit test)\b/i.test(prose) && /\b(?:code|function|script|url|link|fetch|request|html|button|example)\b/i.test(prose);
  const profileIntent = !codeExample && !urls.length && (
    /\b(?:check|search|find|look|research|verify|profile|osint)\b[\s\S]*\b(?:linkedin|github|professional|profiles?|person|people)\b/i.test(prose) ||
    /\b(?:linkedin|github)\b[\s\S]*\b(?:profile|for|of|about)\b/i.test(prose) ||
    /\b(?:[Ww]ho is|[Ww]ho's|[Tt]ell me about|[Rr]esearch|[Ll]ook up)\s+[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){1,3}\b/u.test(prose)
  );
  if (profileIntent) {
    // User turns supply identity context. Assistant guesses are not evidence
    // and must never silently change which person a follow-up researches.
    const userTurns = (Array.isArray(history) ? history : []).filter(turn => turn?.role === "user").slice(-6);
    const context = userTurns.map(turn => String(turn.content || "").slice(0, 1000)).join("\n").slice(-4000);
    return { message: text, urls: [], researchMode: "public_profiles", context };
  }
  if (urls.length && (!codeExample || /\b(?:read|inspect|visit|review|analy[sz]e|evaluate)\b/i.test(prose)) &&
      (inspection || /^https?:\/\/\S+$/i.test(prose))) return { message: text, urls };
  const changing = /\b(?:news|prices?|stocks?|crypto|scores?|results?|matches|election|release|version|schedule|availability|traffic|status|ranking|rates?)\b/i.test(prose)
    && /\b(?:today|tonight|now|currently|latest|live|breaking|recent|this week|this month|as of)\b/i.test(prose);
  if (!codeExample && !/\b(?:weather|forecast|temperature|rain|snow|humidity|wind)\b/i.test(prose) &&
      (changing || /\b(?:search|browse|crawl|look\s*up|research|find)\b[\s\S]{0,60}\b(?:web|internet|online|website|site|news|sources?)\b|\b(?:web|internet|online)\b[\s\S]{0,50}\b(?:search|browse|crawl|research|sources?)\b/i.test(prose))) return { message: text, urls: [] };
  // Resolve short follow-ups against the latest user turn, never a stale URL
  // elsewhere in a long conversation or a URL invented by an assistant.
  const previous = [...(Array.isArray(history) ? history : [])].reverse().find(turn => turn?.role === "user");
  if (previous && /\b(?:it|its|they|their|that|this|those|more|also|pricing|features|contact)\b/i.test(prose) && !codeExample && text.length < 400) {
    const prior = webResearchRequest(previous.content);
    if (prior?.urls.length) return { message: text, urls: prior.urls, context: String(previous.content).slice(0, 4000) };
  }
  return null;
}

export async function fetchWebResearch(request, config, fetchImpl = fetch) {
  if (!config.webResearchUrl || !config.webResearchToken) return {
    content: "Web research is temporarily unavailable because the hosted web worker is not connected. Please try again shortly.", sources: [], error: "unavailable",
  };
  try {
    const response = await fetchImpl(`${config.webResearchUrl}/research`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.webResearchToken}` },
      body: JSON.stringify(request), signal: AbortSignal.timeout(195_000),
    });
    if (!response.ok) return { content: response.status === 429
      ? "The web research worker is busy. Please retry shortly."
      : `The web research service could not complete this request (HTTP ${response.status}). Please retry.`, sources: [], error: "unavailable" };
    const payload = await response.json();
    if (typeof payload.content !== "string" || !payload.content.trim()) throw new Error("Empty research result");
    return { content: payload.content, sources: Array.isArray(payload.sources) ? payload.sources : [], error: payload.error || null };
  } catch (error) {
    return { content: /timeout|abort/i.test(error.name) ? "Web research timed out before it could finish. Please retry."
      : "The hosted web worker could not be reached. Please retry shortly.", sources: [], error: "unavailable" };
  }
}
