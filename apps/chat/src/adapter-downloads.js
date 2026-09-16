// Each OS has its own release channel. GitHub's global "latest" is often Windows.
export const ADAPTER_PLATFORMS = Object.freeze({
  windows: { label: "Windows x64", tag: /^cli-windows-v(\d+\.\d+\.\d+)$/, asset: "MundusX-Setup.exe", minimumInstallerVersion: "0.1.80" },
  "macos-arm64": { label: "macOS · Apple Silicon", tag: /^adapter-macos-v(\d+\.\d+\.\d+)$/, asset: "mundusx-hermes-macos-arm64.tar.gz" },
  "macos-x64": { label: "macOS · Intel", tag: /^adapter-macos-v(\d+\.\d+\.\d+)$/, asset: "mundusx-hermes-macos-x64.tar.gz" },
  "linux-x64": { label: "Linux x64", tag: /^adapter-linux-v(\d+\.\d+\.\d+)$/, asset: "mundusx-hermes-linux-x64.tar.gz" },
  "linux-arm64": { label: "Linux ARM64", tag: /^adapter-linux-v(\d+\.\d+\.\d+)$/, asset: "mundusx-hermes-linux-arm64.tar.gz" },
});

export function detectAdapterOS(userAgent = "") {
  if (/Android|iPhone|iPad|Mobile/i.test(userAgent)) return "unknown";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macos";
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Linux|X11/i.test(userAgent)) return "linux";
  return "unknown";
}
const compare = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
export function selectAdapterRelease(releases, platform, minimumVersion = "0.1.87") {
  const spec = Object.hasOwn(ADAPTER_PLATFORMS, platform) && ADAPTER_PLATFORMS[platform];
  if (!spec) return null;
  return releases.flatMap(release => {
    const version = spec.tag.exec(release.tag_name || "")?.[1];
    if (!version || release.draft || release.prerelease || compare(version, spec.minimumInstallerVersion || minimumVersion) < 0) return [];
    const asset = release.assets?.find(item => item.name === spec.asset && item.size > 0);
    const checksum = release.assets?.find(item => item.name === spec.asset + ".sha256" && item.size > 0);
    const prefix = `https://github.com/mundusx/releases/releases/download/${release.tag_name}/`;
    if (!asset || !checksum || asset.browser_download_url !== prefix + spec.asset || checksum.browser_download_url !== prefix + spec.asset + ".sha256") return [];
    return [{ version, url: asset.browser_download_url, checksum: checksum.browser_download_url }];
  }).sort((a, b) => compare(b.version, a.version))[0] || null;
}

export function createAdapterDownloads({ fetchImpl = fetch, minimumVersion = "0.1.87" } = {}) {
  let cached, expires = 0, pending;
  async function releases() {
    if (cached && Date.now() < expires) return cached;
    if (!pending) pending = (async () => {
      const all = [];
      for (let page = 1; page <= 5; page++) {
        const result = await fetchImpl(`https://api.github.com/repos/mundusx/releases/releases?per_page=100&page=${page}`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "MundusX-Chat" }, signal: AbortSignal.timeout(10_000),
        });
        if (!result.ok) throw new Error("Release lookup unavailable");
        const items = await result.json();
        if (!Array.isArray(items)) throw new Error("Invalid release catalogue");
        all.push(...items);
        if (items.length < 100) break;
      }
      cached = all; expires = Date.now() + 300_000; return all;
    })().finally(() => { pending = null; });
    return pending;
  }
  return async function handleAdapterDownload(request, response, url) {
    if (url.pathname !== "/download/adapter" || !["GET", "HEAD"].includes(request.method)) return false;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Vary", "User-Agent");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const os = detectAdapterOS(request.headers["user-agent"]);
    const selected = url.searchParams.get("platform");
    // A copied Windows URL must not start an .exe download on a Mac or Linux.
    const mismatch = selected && os !== "unknown" && !selected.startsWith(os);
    let catalogue = [], lookupFailed = false;
    try { catalogue = await releases(); } catch { lookupFailed = true; }
    const release = !mismatch && selectAdapterRelease(catalogue, selected, minimumVersion);
    if (release && url.searchParams.get("download") === "1") {
      response.writeHead(302, { Location: release.url }); response.end(); return true;
    }
    const cards = Object.entries(ADAPTER_PLATFORMS).filter(([key]) => os === "unknown" || key.startsWith(os)).map(([key, spec]) => {
      const available = selectAdapterRelease(catalogue, key, minimumVersion);
      return `<section><h2>${spec.label}</h2>${available
        ? `<p>Installer version ${available.version}${key === "windows" ? " · installs from the current production release channel" : ""}</p><a class="button" href="/download/adapter?platform=${key}&download=1">Download for ${spec.label}</a> <a href="${available.checksum}">SHA-256 checksum</a>${key === "windows" ? "" : "<p>Extract the archive, open Terminal in the extracted folder, and run <code>bash setup.sh</code> without sudo. Setup checks the computer architecture and file checksums before installation.</p>"}`
        : `<p>${lookupFailed ? "Unable to check releases right now. Please try again shortly." : "A current Hermes adapter installer is not published for this platform yet."}</p>`}</section>`;
    }).join("");
    response.writeHead(lookupFailed ? 503 : 200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(request.method === "HEAD" ? "" : `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MundusX adapter setup</title><style>body{font:17px system-ui;max-width:760px;margin:48px auto;padding:24px;background:#f5f7fb;color:#172238}section{background:white;padding:24px;margin:20px 0;border-radius:14px}a{color:#1754c5}.button{display:inline-block;padding:12px;background:#1754c5;color:white;border-radius:8px;margin-right:16px}p{line-height:1.6}</style><h1>Set up MundusX + Hermes</h1><p>Choose your computer’s architecture. On Mac, check Apple menu → About This Mac. On Linux, run <code>uname -m</code>: x86_64 means x64; aarch64 means ARM64.</p>${mismatch ? "<p>The requested installer does not match this computer.</p>" : ""}${cards}<p>Only compatible published adapter releases are offered. Compute contribution is not required.</p><a href="/">Return to Chat</a></html>`);
    return true;
  };
}
