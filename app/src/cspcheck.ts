// The plugin lockdown (lockdown.ts) removes what a worker could use to reach
// the network or load code, but the window's content security policy is what
// really stops `import()`, `FontFace` and `eval`, which can't be deleted. If a
// webview didn't apply that policy to workers, plugins would have network
// access again. So before the first plugin runs, a probe worker (without the
// lockdown) tries a fetch, an `import()` and an `eval` the policy forbids, and
// each one must be blocked.
//
// "Blocked" is judged by what happens, not only by a violation report: the probes
// are chosen so that each one can only fail if the policy stopped it (a `data:`
// fetch and a `data:` module need no network; `eval("1")` can't fail on its own).
// Some webviews (WebKitGTK, for one) enforce the policy in workers but never fire
// `securitypolicyviolation` there; judging by reports alone turned plugins off on
// them for no reason. A report still counts as blocked where one arrives.

const PROBE = `
const hits = { fetch: false, import: false, eval: false };
let key = "";
self.addEventListener("securitypolicyviolation", (e) => {
  const d = String(e.effectiveDirective || e.violatedDirective || "");
  if (d.startsWith("connect-src") || d.startsWith("script-src")) hits[key] = true;
});
// run f; if it throws, the policy blocked it (none of these can fail any other way)
const probe = async (name, f) => {
  key = name;
  try { await f(); } catch (e) { hits[name] = true; }
  await new Promise((r) => setTimeout(r, 30)); // let a late violation report arrive
};
(async () => {
  await probe("fetch", () => fetch("data:text/plain,csp-probe").then((r) => r.text()));
  await probe("import", () => import("data:text/javascript,export default 1"));
  await probe("eval", () => eval("1"));
  postMessage({ hits });
})();
`;

let verdict: Promise<{ ok: boolean; why?: string }> | null = null;

/** Does the window's policy hold inside plugin workers? Checked once. */
export function pluginSandboxHolds(): Promise<{ ok: boolean; why?: string }> {
  return (verdict ??= new Promise((resolve) => {
    let url = "";
    try {
      url = URL.createObjectURL(new Blob([PROBE], { type: "text/javascript" }));
      const w = new Worker(url);
      const done = (v: { ok: boolean; why?: string }) => {
        clearTimeout(timer);
        w.terminate();
        URL.revokeObjectURL(url);
        resolve(v);
      };
      const timer = setTimeout(() => done({ ok: false, why: "the plugin safety check didn't finish, so plugins won't run; everything else works as usual" }), 5000);
      w.onerror = () => done({ ok: false, why: "the plugin safety check couldn't run, so plugins won't run; everything else works as usual" });
      w.onmessage = (e) => {
        const d = e.data ?? {};
        const h = d.hits ?? {};
        const open = ["fetch", "import", "eval"].filter((k) => !h[k]);
        done(open.length ? { ok: false, why: `SketchCraft couldn't confirm that plugins are walled off from the network on this system (${open.join(", ")} not blocked), so it won't run them; everything else works as usual` } : { ok: true });
      };
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      resolve({ ok: false, why: `the safety check couldn't start: ${String(e)}` });
    }
  }));
}

/** Test hook: forget the verdict. */
export function resetPluginSandboxCheck() {
  verdict = null;
}
