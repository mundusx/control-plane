import { isSkillAdministrator } from "../../auth.js";
import { validateSkillDraft } from "./registry.js";
import { httpError } from "../../shared/http-error.js";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSkillsHttpController({ authStore, registry, readJsonBody, sendJson }) {
  return async function handleSkillsRequest({ request, response, url }) {
    if (!url.pathname.startsWith("/api/skills")) return false;
    const session = request.mundusxSession ?? await authStore.session(request);
    if (!session) throw httpError(401, "Authentication is required to manage skills");

    if (request.method === "GET" && url.pathname === "/api/skills") {
      const admin = isSkillAdministrator(session.role);
      const [personal, overrides] = await Promise.all([
        authStore.listUserSkills(session.id),
        authStore.globalSkillOverrides(),
      ]);
      const byId = new Map(overrides.map((item) => [item.skill_id, item]));
      const system = registry.catalog().map((entry) => {
        const override = byId.get(entry.id);
        return {
          ...entry,
          enabled: override ? override.enabled : entry.enabled,
          version: override?.version ?? 1,
          updated_at: override?.updated_at ?? null,
          ...(admin ? { content: override?.content ?? registry.rawContent(entry.id) } : {}),
        };
      });
      sendJson(response, 200, { system, personal, permissions: { edit_global: admin, edit_personal: true } });
      return true;
    }

    if (["POST", "PUT", "DELETE"].includes(request.method)) authStore.requireCsrf(request, session);
    if (request.method === "POST" && url.pathname === "/api/skills/personal") {
      sendJson(response, 201, await authStore.saveUserSkill(session.id, validateInput(await readJsonBody(request))));
      return true;
    }
    const personal = url.pathname.match(/^\/api\/skills\/personal\/([0-9a-f-]{36})$/i);
    if (personal && !UUID.test(personal[1])) throw httpError(400, "Skill id is invalid");
    if (personal && request.method === "PUT") {
      sendJson(response, 200, await authStore.saveUserSkill(session.id, validateInput(await readJsonBody(request)), personal[1]));
      return true;
    }
    if (personal && request.method === "DELETE") {
      sendJson(response, 200, await authStore.deleteUserSkill(session.id, personal[1]));
      return true;
    }
    const global = url.pathname.match(/^\/api\/skills\/global\/([a-z0-9-]+)$/);
    if (global && request.method === "PUT") {
      if (!isSkillAdministrator(session.role)) throw httpError(403, "Platform administrator access is required");
      if (!registry.has(global[1])) throw httpError(404, "Global skill not found");
      sendJson(response, 200, await authStore.saveGlobalSkill(session, global[1], validateInput(await readJsonBody(request), { global: true })));
      return true;
    }
    throw httpError(404, "Skill endpoint not found");
  };
}

function validateInput(input = {}, { global = false } = {}) {
  const content = String(input.content || "").trim();
  const validation = validateSkillDraft(content);
  if (!validation.valid) throw httpError(400, validation.errors.join("; "));
  if (global) return { content, enabled: input.enabled !== false };
  const slug = String(input.slug || "").trim().toLowerCase();
  const title = String(input.title || "").trim();
  const description = String(input.description || "").trim();
  if (!SLUG.test(slug)) throw httpError(400, "Slug must use lowercase hyphenated words");
  if (!title || title.length > 100) throw httpError(400, "Title must contain 1 to 100 characters");
  if (description.length > 500) throw httpError(400, "Description must not exceed 500 characters");
  return { slug, title, description, content, enabled: input.enabled !== false };
}
