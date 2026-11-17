import { useEffect, useState } from "./html.js";

/** Polls a JSON endpoint while `enabled`. Until it answers, or if it fails, the value stays null.
 * @param {string} url
 * @param {number} ms
 * @param {boolean} enabled
 * @returns {[any, (v: any) => void]} */
export function usePoll(url, ms, enabled) {
  const [value, setValue] = useState(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const poll = () =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then((v) => alive && v && setValue(v))
        .catch(() => {});
    void poll();
    const t = setInterval(poll, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url, ms, enabled]);
  return [value, setValue];
}

/** POSTs JSON with the session's CSRF token. Resolves to the parsed body, or throws an Error with the backend's message.
 * @param {string} path
 * @param {unknown} body
 * @param {string} csrf */
export async function postJson(path, body, csrf) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!r) throw Error("The backend did not answer.");
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(v.error ?? `Failed (${r.status})`);
  return v;
}
