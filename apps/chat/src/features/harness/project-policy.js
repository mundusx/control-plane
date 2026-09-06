import { httpError } from "../../shared/http-error.js";

const PROJECT_TEMPLATES = new Set(["generic", "java-maven"]);

const GENERIC_PATH_PREFIXES = Object.freeze([
  "src",
  "tests",
  "docs",
  "README.md",
  ".gitignore",
  ".mundusx",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "poetry.lock",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "Makefile",
]);

const JAVA_MAVEN_PATH_PREFIXES = Object.freeze([
  "src",
  "pom.xml",
  "README.md",
  ".gitignore",
  ".mundusx",
]);

export function localProjectAuthority(session, body) {
  if (!session?.id) {
    throw httpError(401, "Authentication is required for local project authority");
  }

  const slug = String(body?.project_slug || "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw httpError(400, "project_slug must be a lowercase hyphenated name");
  }

  const template = String(body?.project_template || "generic");
  if (!PROJECT_TEMPLATES.has(template)) {
    throw httpError(400, "project_template is not supported");
  }

  const javaMaven = template === "java-maven";
  return {
    tenant_id: `owner:${session.id}`,
    repository_source_id: `local-project:${session.id}:${template}:${slug}`,
    allowed_path_prefixes: [...(javaMaven ? JAVA_MAVEN_PATH_PREFIXES : GENERIC_PATH_PREFIXES)],
    validation_profiles: [javaMaven ? "java-maven-test" : "repository-default"],
    base_revision: "0".repeat(40),
    allowed_execution_modes: ["sandbox", "hybrid"],
  };
}
