// nav.js — injects the nav and marks the active link
(function () {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  const pages = [
    { href: '../index.html',   label: 'Home' },
    { href: '../about.html',   label: 'About' },
    { href: '../work.html',    label: 'Core Work' },
    { href: '../drivers.html', label: 'Driver Lab' },
    { href: '../contact.html', label: 'Contact' },
  ];

  // depth: 0 = root pages, 1 = drivers/ subfolder
  const depth = window.location.pathname.includes('/drivers/') ? 1 : 0;

  const links = pages.map(p => {
    const href = depth === 0 ? p.href.replace('../', '') : p.href;
    const name = href.split('/').pop() || 'index.html';
    const active = name === path ? ' class="active"' : '';
    return `<li><a href="${href}"${active}>${p.label}</a></li>`;
  }).join('');

  const nav = `
  <nav class="nav">
    <a href="${depth ? '../' : ''}index.html" class="nav-logo">
      <div class="nav-logo-mark">
        <span></span><span></span><span></span><span></span>
      </div>
      Embedded&nbsp;Forge
    </a>
    <ul class="nav-links" id="nav-links">${links}</ul>
    <button class="nav-burger" id="burger" aria-label="Menu">
      <span></span><span></span><span></span>
    </button>
  </nav>`;

  document.body.insertAdjacentHTML('afterbegin', nav);

  document.getElementById('burger').addEventListener('click', () => {
    document.getElementById('nav-links').classList.toggle('open');
  });
})();
