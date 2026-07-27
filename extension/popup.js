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

/** Host-permission patterns the selected service needs, e.g. https://*.amazon.fr/*. */
function originsFor(svc) {
  return svc.domains.map((d) => `https://*.${d}/*`);
}

/**
 * Firefox (Manifest V3) does not grant manifest host permissions at install — the user opts in,
 * and newly added hosts stay ungranted after an update. Chrome grants them up front. So check
 * before reading cookies and, if they are missing, ask for them from the click that needs them
 * (permissions.request must run in a user gesture).
 */
async function ensureAccess(svc) {
  const origins = originsFor(svc);
  try {
    // request() is called directly rather than after a contains() check: it resolves to true
    // without prompting when the permission is already held, and Firefox requires request() to
    // run inside the user gesture — an await beforehand can invalidate that.
    return await api.permissions.request({ origins });
  } catch {
    // Older engines without the permissions API: assume the manifest grant applies.
    return true;
  }
}

async function collect() {
  const svc = SERVICES.find((s) => s.id === $service.value);
  if (!svc) return { text: "", count: 0, label: "" };
  if (!(await ensureAccess(svc))) {
    return { text: "", count: 0, label: svc.label, denied: true };
  }
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
    const { text, count, label, denied } = await collect();
    if (denied) {
      setStatus(`Access to ${label} sites was declined, so cookies can't be read.`, "err");
      return;
    }
    if (count === 0) {
      setStatus(`No cookies found for ${label}. Are you signed in on that site?`, "err");
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
    const { text, count, label, denied } = await collect();
    if (denied) {
      setStatus(`Access to ${label} sites was declined, so cookies can't be read.`, "err");
      return;
    }
    if (count === 0) {
      setStatus(`No cookies found for ${label}. Are you signed in on that site?`, "err");
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
