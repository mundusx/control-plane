// Embedded in the authenticated chat page; file operations use the paired connector.
let expandedProject = null;
const expandedProjectPaths = new Set();
const projectDirectoryCache = new Map();
const projectDirectoryPending = new Set();
const projectBrowserDevices = new Map();
const projectTreeStyle = document.createElement("style");
projectTreeStyle.textContent = `
.project-tree-row { display:flex; align-items:center; min-width:0; }
.project-tree-row .sidebar-project-choice { flex:1; min-width:0; padding:7px 4px; gap:5px; }
.project-tree-control { border:0; background:transparent; color:var(--muted); border-radius:5px; cursor:pointer; padding:6px; min-width:25px; }
.project-tree-control:hover { color:var(--text); background:var(--panel-2); }
.project-tree-note { color:var(--muted); font-size:12px; padding:6px; overflow-wrap:anywhere; }
.project-browser-dialog { width:min(760px,90vw); max-height:85vh; overflow:auto; border:1px solid var(--line); border-radius:14px; padding:20px; background:var(--panel); color:var(--text); }
.project-browser-dialog::backdrop { background:#0007; }
.project-browser-dialog header { display:flex; justify-content:space-between; gap:15px; align-items:center; }
.project-browser-dialog h2 { margin:0; font-size:18px; overflow-wrap:anywhere; }
.project-browser-dialog button { font:inherit; padding:8px 12px; border:1px solid var(--line); border-radius:7px; color:var(--text); background:var(--panel-2); cursor:pointer; }
.project-browser-dialog button:disabled { opacity:.5; cursor:wait; }
.project-browser-dialog textarea,.project-browser-dialog input { box-sizing:border-box; width:100%; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:12px; font:14px/1.6 monospace; }
.project-browser-dialog textarea { min-height:300px; resize:vertical; }
.project-browser-dialog pre { white-space:pre-wrap; overflow-wrap:anywhere; font:13px/1.6 monospace; }
.project-browser-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.project-browser-dialog p { font-size:13px; color:var(--muted); }
.project-actions-popover { width:224px; min-width:0; max-width:calc(100vw - 16px); max-height:calc(100vh - 16px); overflow-y:auto; box-sizing:border-box; }
.project-actions-popover hr { margin:4px 3px; border:0; border-top:1px solid var(--line); }
`;
document.head.append(projectTreeStyle);

function projectBrowserDialog(title) {
  const dialog = document.createElement("dialog"); dialog.className = "project-browser-dialog";
  const header = document.createElement("header");
  const heading = document.createElement("h2"); heading.textContent = title;
  const close = document.createElement("button"); close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());
  header.append(heading, close); dialog.append(header);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog); dialog.showModal(); return dialog;
}

async function projectOperation(slug, request, write = false) {
  const statusResponse = await fetch("/api/agent/status", {cache:"no-store"});
  if (!statusResponse.ok) throw new Error(statusResponse.status === 401 ? "Please sign in to browse this project." : "Could not check the local connection. Try again shortly.");
  const status = await statusResponse.json();
  const capable = status.connections?.filter((connection) => connection.online && connection.capabilities?.project_browser === true) || [];
  const previousDevice = projectBrowserDevices.get(slug);
  const device = previousDevice ? capable.find((connection) => connection.connection_id === previousDevice) : capable[0];
  if (!device) {
    if (previousDevice && capable.length) throw new Error("This project's connected computer is offline or unavailable. Reconnect that computer, then retry. Files will not be opened on a different computer automatically.");
    const online = status.connections?.filter((connection) => connection.online) || [];
    if (online.length) throw new Error("Your connected app does not advertise project-file support. Update the MundusX desktop app, then restart it and retry.");
    throw new Error("No local computer is connected to this signed-in account. Open MundusX on the project's computer and check its connection, then retry.");
  }
  projectBrowserDevices.set(slug, device.connection_id);
  const response = await fetch("/api/agent/tasks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "MUNDUSX_PROJECT_IO_V1:" + JSON.stringify({...request, connection_id:device.connection_id}), workspace_relative: slug, runtime: "auto", allow_mutations: write }),
  });
  const task = await response.json();
  if (!response.ok) throw new Error(task.error || "Could not send the project request.");
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const poll = await fetch("/api/agent/tasks/" + task.task_id);
    const state = await poll.json();
    if (!poll.ok) throw new Error(state.error || "Could not check the project request.");
    if (state.state === "completed") return state.result || {};
    if (["failed", "cancelled"].includes(state.state)) throw new Error(state.error || "Project request cancelled.");
  }
  throw new Error("The connector is still busy. This request may complete later; refresh the folder to check before trying again.");
}

function projectTreeKey(slug, path) { return slug + ":" + path; }
async function loadProjectDirectory(slug, path = "") {
  const key = projectTreeKey(slug, path);
  if (projectDirectoryPending.has(key)) return;
  projectDirectoryPending.add(key); projectDirectoryCache.delete(key); renderSidebarProjects();
  try { projectDirectoryCache.set(key, await projectOperation(slug, { operation:"list", path })); }
  catch (error) { projectDirectoryCache.set(key, { error: error.message }); }
  finally { projectDirectoryPending.delete(key); renderSidebarProjects(); }
}

function projectTreeButton(text, action, slug, path, className = "project-tree-control") {
  const button = document.createElement("button"); button.type = "button"; button.className = className; button.textContent = text;
  Object.assign(button.dataset, { treeAction:action, projectSlug:slug, path }); return button;
}

function appendProjectTreeRow(parent, slug, path, label, directory, root, depth) {
  const expanded = root ? expandedProject === slug : expandedProjectPaths.has(projectTreeKey(slug, path));
  const row = document.createElement("div"); row.className = "project-tree-row"; row.style.paddingLeft = depth * 12 + "px";
  Object.assign(row.dataset, { projectSlug:slug, path, directory:String(directory), root:String(root) });
  if (directory) {
    const arrow = projectTreeButton(expanded ? "▾" : "▸", "toggle", slug, path);
    arrow.setAttribute("aria-label", (expanded ? "Collapse " : "Expand ") + label); arrow.setAttribute("aria-expanded", String(expanded)); row.append(arrow);
  }
  const name = projectTreeButton("", directory ? "select" : "preview", slug, path, "sidebar-project-choice");
  name.innerHTML = directory ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 3h8l4 4v14H6Z"/></svg>';
  const labelEl = document.createElement("span"); labelEl.textContent = label; name.append(labelEl);
  name.title = path || slug;
  if (root) name.setAttribute("aria-current", String(activeProject?.slug === slug));
  const menu = projectTreeButton("⋯", "menu", slug, path); menu.setAttribute("aria-label", "Actions for " + label); menu.setAttribute("aria-haspopup", "menu"); menu.setAttribute("aria-expanded", "false");
  row.append(name, menu); parent.append(row);
  if (directory && expanded) appendProjectDirectory(parent, slug, path, depth + 1);
}

function appendProjectDirectory(parent, slug, path, depth) {
  const key = projectTreeKey(slug, path), data = projectDirectoryCache.get(key);
  if (!data || data.error || !data.entries?.length) {
    const note = document.createElement("div"); note.className = "project-tree-note";
    note.style.paddingLeft = depth * 12 + "px";
    note.textContent = projectDirectoryPending.has(key) ? "Loading local files…" : data?.error || "Empty folder";
    parent.append(note);
    if (data?.error && !projectDirectoryPending.has(key)) {
      const retry = projectTreeButton("Retry loading files", "refresh", slug, path);
      parent.append(retry);
    }
    return;
  }
  for (const entry of data.entries) appendProjectTreeRow(parent, slug, path ? path + "/" + entry.name : entry.name, entry.name, entry.directory, false, depth);
  if (data.truncated) { const note = document.createElement("p"); note.className = "project-tree-note"; note.textContent = "Showing the first 500 entries."; parent.append(note); }
}

function renderSidebarProjects() {
  if (!sidebarProjectListEl) return;
  sidebarProjectListEl.replaceChildren();
  if (!availableProjectSlugs.length) { const note = document.createElement("p"); note.className = "project-tree-note"; note.textContent = "No projects yet. Use + to create one."; sidebarProjectListEl.append(note); }
  for (const slug of availableProjectSlugs) appendProjectTreeRow(sidebarProjectListEl, slug, "", slug, true, true, 0);
}

async function handleProjectTreeClick(event) {
  const button = event.target.closest("button[data-tree-action]"); if (!button) return;
  const { treeAction:action, projectSlug:slug, path } = button.dataset;
  const row = button.closest(".project-tree-row");
  if (action === "refresh") { await loadProjectDirectory(slug, path); return; }
  if (action === "menu") { showProjectActions(slug, path, row.dataset.directory === "true", row.dataset.root === "true", button); return; }
  if (action === "preview") {
    const dialog = projectBrowserDialog(path); const content = document.createElement("pre"); content.textContent = "Loading preview…"; dialog.append(content);
    try { const result = await projectOperation(slug, {operation:"read", path}); content.textContent = result.content + (result.truncated ? "\n\n[Preview truncated to 8,000 characters]" : ""); } catch (error) { content.textContent = error.message; } return;
  }
  if (action === "select") { setActiveProject({slug}); setWorkspaceDestination("chats"); }
  if (!path) {
    expandedProject = action === "toggle" && expandedProject === slug ? null : slug;
    expandedProjectPaths.clear(); // One project's nested tree is open at a time.
  } else {
    const key = projectTreeKey(slug, path);
    if (action === "toggle" && expandedProjectPaths.has(key)) expandedProjectPaths.delete(key); else expandedProjectPaths.add(key);
  }
  renderSidebarProjects();
  if (expandedProject === slug && (!path || expandedProjectPaths.has(projectTreeKey(slug, path)))) await loadProjectDirectory(slug, path);
}

sidebarProjectListEl?.addEventListener("contextmenu", (event) => {
  const row = event.target.closest(".project-tree-row"); if (!row) return;
  event.preventDefault(); showProjectActions(row.dataset.projectSlug, row.dataset.path, row.dataset.directory === "true", row.dataset.root === "true", row.querySelector('[data-tree-action="menu"]'), {x:event.clientX,y:event.clientY});
});

let projectActionsMenu = null;
let projectActionsAnchor = null;
function closeProjectActions(restoreFocus = false) {
  projectActionsMenu?.remove(); projectActionsMenu = null;
  const anchor = projectActionsAnchor; projectActionsAnchor = null;
  anchor?.setAttribute("aria-expanded", "false");
  if (restoreFocus && anchor?.isConnected) anchor.focus();
}
document.addEventListener("pointerdown", (event) => {
  if (!projectActionsMenu?.contains(event.target) && !event.target.closest('[data-tree-action="menu"]')) closeProjectActions();
});
window.addEventListener("resize", () => closeProjectActions());
document.addEventListener("scroll", (event) => { if (projectActionsMenu && !projectActionsMenu.contains(event.target)) closeProjectActions(); }, true);

function showProjectActions(slug, path, directory, root, anchor, position) {
  const wasOpen = projectActionsMenu && projectActionsAnchor === anchor;
  closeProjectActions(); closeHistoryMenu();
  if (wasOpen && !position) return;
  const actions = document.createElement("div"); actions.className = "history-context-menu project-actions-popover is-open";
  actions.setAttribute("role", "menu"); actions.setAttribute("aria-label", "Actions for " + (path || slug));
  projectActionsMenu = actions; projectActionsAnchor = anchor;
  anchor?.setAttribute("aria-expanded", "true");
  const separator = () => { const line = document.createElement("hr"); line.setAttribute("role", "separator"); actions.append(line); };
  function action(label, callback) {
    const button = document.createElement("button"); button.type = "button"; button.setAttribute("role", "menuitem"); button.textContent = label;
    if (label === "Remove from sidebar") button.className = "danger";
    button.addEventListener("click", async () => { closeProjectActions(true); try { await callback(); } catch (error) { showToast(error.message); } }); actions.append(button);
  }
  if (root) {
    action("New chat in this project", () => { newChatEl.click(); setActiveProject({slug}); });
    action("Project instructions", () => editProjectDocument(slug, "instructions"));
    action("Project skills", () => editProjectDocument(slug, "skills"));
    action("Saved prompts", () => editProjectDocument(slug, "prompts"));
    separator();
  }
  if (directory) {
    action("New file", () => createProjectEntry(slug, path, false));
    action("New folder", () => createProjectEntry(slug, path, true));
    action("Open in Explorer", () => projectOperation(slug, {operation:"open", path}));
    action("Refresh files", () => loadProjectDirectory(slug, path));
    if (!root) action("Use as task scope", () => { setActiveProject({slug}); promptEl.value = "Work within folder " + JSON.stringify(path) + ".\n\n" + promptEl.value; promptEl.dispatchEvent(new Event("input", {bubbles:true})); promptEl.focus(); });
  }
  if (!root) action("Copy relative path", () => navigator.clipboard.writeText(path));
  if (root) { separator(); action("Remove from sidebar", () => { if (expandedProject === slug) expandedProject = null; removeProject(slug); }); }
  actions.addEventListener("keydown", (event) => {
    const buttons = [...actions.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); closeProjectActions(true); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length-1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  });
  actions.addEventListener("focusout", (event) => {
    // Focus changes can run microtasks before the next button receives focus.
    // Keep the menu mounted through pointer activation of another menu item.
    if (actions.contains(event.relatedTarget) || event.relatedTarget === anchor) return;
    setTimeout(() => { if (projectActionsMenu === actions && !actions.contains(document.activeElement) && document.activeElement !== anchor) closeProjectActions(); }, 0);
  });
  document.body.append(actions);
  const rect = anchor?.getBoundingClientRect() || {left:8,right:8,top:8};
  const beside = rect.right + 6 + actions.offsetWidth <= window.innerWidth - 8 ? rect.right + 6 : rect.left - actions.offsetWidth - 6;
  actions.style.left = Math.max(8, Math.min(position?.x ?? beside, window.innerWidth - actions.offsetWidth - 8)) + "px";
  actions.style.top = Math.max(8, Math.min(position?.y ?? rect.top, window.innerHeight - actions.offsetHeight - 8)) + "px";
  actions.querySelector("button")?.focus({preventScroll:true});
}

async function editProjectDocument(slug, section) {
  const dialog = projectBrowserDialog(slug + " · " + section);
  const note = document.createElement("p");
  const descriptions = {
    instructions: "Project-wide rules and context, such as architecture, coding conventions, and build commands.",
    skills: "Reusable project workflows, such as how to add an endpoint or verify a change. These are text instructions, not installed Hermes tools.",
    prompts: "Reusable request templates. Use ## headings to separate them. Choose a prompt to put it in the composer; it runs only when you send it.",
  };
  note.textContent = descriptions[section] + " Saved locally in .mundusx/" + section + ".md." + (section === "prompts" ? "" : " Included in subsequent project tasks. Keep under 8 KB. Current user requests take priority.");
  const editor = document.createElement("textarea"); editor.setAttribute("aria-label", "Project " + section); editor.disabled = true;
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = "Loading…";
  const actions = document.createElement("div"); actions.className = "project-browser-actions";
  const save = document.createElement("button"); save.textContent = "Save " + section; save.disabled = true; actions.append(save);
  dialog.append(note, editor, status, actions);
  const retry = document.createElement("button"); retry.textContent = "Retry loading"; retry.hidden = true; actions.append(retry);
  const use = section === "prompts" ? document.createElement("button") : null;
  if (use) { use.textContent = "Choose a prompt"; use.disabled = true; actions.append(use); }
  async function loadDocument() {
    retry.hidden = true; editor.disabled = true; save.disabled = true;
    if (use) use.disabled = true;
    status.textContent = "Loading�";
    try {
      editor.value = (await projectOperation(slug, {operation:"config_read", section})).content || "";
      editor.disabled = false; save.disabled = false; status.textContent = "";
      if (use) use.disabled = false;
    } catch (error) { status.textContent = error.message; retry.hidden = false; }
  }
  retry.addEventListener("click", loadDocument);
  await loadDocument();
  save.addEventListener("click", async () => {
    save.disabled = true; status.textContent = "Saving…";
    try { await projectOperation(slug, {operation:"config_write", section, content:editor.value}, true); status.textContent = "Saved to this project."; }
    catch (error) { status.textContent = error.message; } finally { save.disabled = false; }
  });
  if (use) {
    use.addEventListener("click", () => {
      const picker = projectBrowserDialog("Saved prompts");
      for (const text of editor.value.split(/^## /m).filter((part) => part.trim())) {
        const newline = text.indexOf("\n"), hasHeadings = /^## /m.test(editor.value), title = !hasHeadings || newline < 0 ? "Use prompt" : text.slice(0, newline), content = !hasHeadings || newline < 0 ? text : text.slice(newline + 1).trim();
        const button = document.createElement("button"); button.textContent = title;
        button.addEventListener("click", () => { setActiveProject({slug}); promptEl.value = content; promptEl.dispatchEvent(new Event("input", {bubbles:true})); picker.close(); dialog.close(); promptEl.focus(); }); picker.append(button);
      }
    });
  }
}

function createProjectEntry(slug, parent, directory) {
  const dialog = projectBrowserDialog(directory ? "New folder" : "New file"), input = document.createElement("input"); input.setAttribute("aria-label", "Name"); input.placeholder = "Name";
  const button = document.createElement("button"); button.textContent = "Create"; const status = document.createElement("p"); status.setAttribute("role", "status"); dialog.append(input, button, status); input.focus();
  button.addEventListener("click", async () => {
    const name = input.value.trim(); if (!name || /[\\/:]/.test(name) || name === "." || name === "..") { status.textContent = "Enter a file or folder name."; return; }
    button.disabled = true; status.textContent = "Creating…";
    try { await projectOperation(slug, {operation:directory ? "new_folder" : "new_file", path:parent ? parent + "/" + name : name}, true); dialog.close(); await loadProjectDirectory(slug, parent); }
    catch (error) { status.textContent = error.message; button.disabled = false; }
  });
}
