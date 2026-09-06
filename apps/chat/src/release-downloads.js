export const RELEASE_DOWNLOAD_PATH = "/prod/latest/";
export const RELEASE_BACKEND_BASE_URL =
  "https://github.com/mundusx/releases/releases/latest/download";

export const RELEASE_ASSETS = Object.freeze([
  "install-harness-runner.sh",
  "install-harness-runner.sh.sha256",
  "mundusx-harness-runner-aarch64-apple-darwin",
  "mundusx-harness-runner-aarch64-apple-darwin.sha256",
  "mundusx-harness-runner-x86_64-pc-windows-msvc.exe",
  "mundusx-harness-runner-x86_64-pc-windows-msvc.exe.sha256",
  "mundusx-harness-runner-x86_64-unknown-linux-gnu",
  "mundusx-harness-runner-x86_64-unknown-linux-gnu.sha256",
  "mundusx-harness-setup-windows-x86_64.exe",
  "mundusx-harness-setup-windows-x86_64.exe.sha256",
  "release-manifest.json",
  "release-manifest.json.sig",
]);

const RELEASE_ASSET_SET = new Set(RELEASE_ASSETS);

export function releaseDownloadLocation(pathname) {
  if (!pathname.startsWith(RELEASE_DOWNLOAD_PATH)) return null;
  const asset = pathname.slice(RELEASE_DOWNLOAD_PATH.length);
  if (!RELEASE_ASSET_SET.has(asset)) return null;
  return `${RELEASE_BACKEND_BASE_URL}/${asset}`;
}

