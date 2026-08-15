// Standalone theme-toggle click handler for static pages (terms.html,
// privacy.html) that don't load the full app.js bundle — pulling in app.js
// there would immediately throw on the dozens of app-only elements
// (loginForm, holdingForm, etc.) it expects to find and bind to. Kept in
// its own same-origin file (not inline) so the CSP's strict script-src
// still covers it. theme-init.js (also loaded on these pages) only sets
// the *initial* theme before paint; this handles the click afterward.
document.getElementById("themeToggleBtn").addEventListener("click", () => {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  if (isLight) {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("theme", "dark");
  } else {
    document.documentElement.setAttribute("data-theme", "light");
    localStorage.setItem("theme", "light");
  }
});
