document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('navToggle');
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('scrim');
  if (!toggle || !sidebar) return;

  function close() {
    sidebar.classList.remove('open');
    document.body.classList.remove('nav-open');
  }
  toggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    document.body.classList.toggle('nav-open');
  });
  if (scrim) scrim.addEventListener('click', close);
  sidebar.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
});
