// Before the first paint (a classic blocking script in <head>; CSP allows only own files, no inline code): the theme
// chosen in Settings (cached in localStorage by src/ui/common/theme.ts) or the system one, so a window never flashes.
(function () {
  var p = 'system';
  try { p = localStorage.getItem('aw.theme') || 'system'; } catch (e) { /* no storage */ }
  var dark = p === 'dark' || (p !== 'light' && !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
