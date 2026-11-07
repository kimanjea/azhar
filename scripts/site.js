// Azhar Amir Kimanje · site behavior. Content works without this file; it only adds polish.
(() => {
  const root = document.documentElement;
  root.classList.add('js');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // Nav gains a hairline only once content scrolls beneath it.
  const nav = document.querySelector('.nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 4);
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // Mobile menu: a disclosure, not a modal. Escape and link taps close it.
  const toggle = document.querySelector('.nav-toggle');
  const panel = document.getElementById('nav-panel');
  if (toggle && panel) {
    const set = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.querySelector('.label').textContent = open ? 'Close' : 'Menu';
      if (open) panel.setAttribute('data-open', ''); else panel.removeAttribute('data-open');
    };
    toggle.addEventListener('click', () => set(toggle.getAttribute('aria-expanded') !== 'true'));
    panel.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { set(false); toggle.focus(); }
    });
    matchMedia('(min-width: 861px)').addEventListener('change', (e) => { if (e.matches) set(false); });
  }

  // Copy email, with immediate feedback announced to screen readers.
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    const original = btn.textContent;
    const status = document.getElementById('copy-status');
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy');
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = false; }
      btn.textContent = ok ? 'Copied' : 'Select and copy';
      if (status) status.textContent = ok ? 'Email address copied to clipboard.' : 'Copy failed. The address is shown on the page.';
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { btn.textContent = original; }, 2000);
    });
  });

  // Reveal on scroll: once, small, staggered. Skipped entirely under Reduce Motion.
  const items = document.querySelectorAll('.reveal');
  // Arriving on a deep link (#publications) jumps mid-page: show everything at once, never a blank screen.
  if (!reduceMotion.matches && !location.hash && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach((el) => {
      // Anything already on screen at load shows immediately; no flash of hidden content.
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) el.classList.add('is-in');
      else io.observe(el);
    });
  } else {
    items.forEach((el) => el.classList.add('is-in'));
  }

  // Footer year
  document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });
})();
