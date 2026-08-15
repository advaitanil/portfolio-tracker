// Extracted from an inline <head> script (Day 23 security review, S-3): a
// strict Content-Security-Policy with no 'unsafe-inline' on script-src can't
// allow an inline <script> block, hash-pinning it would silently break on
// the next edit, and a nonce isn't workable on a static host with no
// per-request templating — an external, same-origin file is the simplest
// fix that keeps CSP strict. Loaded as a normal blocking <script src> (not
// async/defer) so it still runs before first paint, same as the inline
// version did — that's what avoids a flash of the wrong theme.
(function () {
  var saved = localStorage.getItem("theme");
  var wantsLight = saved ? saved === "light" : window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  if (wantsLight) document.documentElement.setAttribute("data-theme", "light");
})();
