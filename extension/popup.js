import { SERVICES, serviceForUrl, toNetscape, dedupeCookies } from "./cookies.js";

// Cross-browser namespace: Firefox exposes `browser` (promises), Chrome exposes `chrome`
// (promises in MV3). Both work with await.
const api = globalThis.browser ?? globalThis.chrome;

const $service = document.getElementById("service");
const $status = document.getElementById("status");

function setStatus(msg, kind) {
  $status.textContent = msg;
  $status.className = `status ${kind ?? ""}`;
}

for (const svc of SERVICES) {
  const opt = document.createElement("option");
  opt.value = svc.id;
  opt.textContent = svc.label;
  $service.appendChild(opt);
}

// Preselect the service matching the active tab, when recognizable.
(async () => {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const id = tab?.url ? serviceForUrl(tab.url) : null;
    if (id) $service.value = id;
  } catch {
    /* ignore */
  }
})();

async function collect() {
  const svc = SERVICES.find((s) => s.id === $service.value);
  if (!svc) return { text: "", count: 0, label: "" };
  const all = [];
  for (const domain of svc.domains) {
    const cookies = await api.cookies.getAll({ domain });
    all.push(...cookies);
  }
  const unique = dedupeCookies(all);
  return { text: toNetscape(unique), count: unique.length, label: svc.label };
}

document.getElementById("copy").addEventListener("click", async () => {
  try {
    const { text, count, label } = await collect();
    if (count === 0) {
      setStatus(`No cookies found for ${label}. Are you logged in?`, "err");
      return;
    }
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${count} cookies for ${label}. Paste into Session import.`, "ok");
  } catch (e) {
    setStatus(`Could not read cookies: ${String(e)}`, "err");
  }
});

document.getElementById("download").addEventListener("click", async () => {
  try {
    const { text, count, label } = await collect();
    if (count === 0) {
      setStatus(`No cookies found for ${label}. Are you logged in?`, "err");
      return;
    }
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${$service.value}-cookies.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Downloaded ${count} cookies for ${label}.`, "ok");
  } catch (e) {
    setStatus(`Could not read cookies: ${String(e)}`, "err");
  }
});
