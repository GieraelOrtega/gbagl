/**
 * main.js — GBAGL client-side interactivity
 * Vanilla JS only, no frameworks.
 */

document.addEventListener('DOMContentLoaded', () => {

  // ── Mobile navigation toggle ────────────────────────────────
  const navToggle = document.getElementById('navToggle');
  const navLinks  = document.getElementById('navLinks');

  if (navToggle && navLinks) {
    const nav = navToggle.closest('.nav');
    const setNavOpen = (open, returnFocus = false) => {
      navLinks.classList.toggle('nav__links--open', open);
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
      document.body.classList.toggle('nav-open', open);
      if (returnFocus) navToggle.focus();
    };

    navToggle.addEventListener('click', () => {
      setNavOpen(navToggle.getAttribute('aria-expanded') !== 'true');
    });

    navLinks.querySelectorAll('.nav__link').forEach(link => {
      link.addEventListener('click', () => setNavOpen(false));
    });

    document.addEventListener('click', (event) => {
      if (
        navToggle.getAttribute('aria-expanded') === 'true'
        && nav
        && !nav.contains(event.target)
      ) setNavOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && navToggle.getAttribute('aria-expanded') === 'true') {
        setNavOpen(false, true);
      }
    });
    nav.addEventListener('focusout', () => {
      window.requestAnimationFrame(() => {
        if (
          navToggle.getAttribute('aria-expanded') === 'true'
          && !nav.contains(document.activeElement)
        ) setNavOpen(false);
      });
    });

    const mobileNav = window.matchMedia('(max-width: 900px)');
    const handleNavBreakpoint = (event) => {
      if (!event.matches) setNavOpen(false);
    };
    if (mobileNav.addEventListener) {
      mobileNav.addEventListener('change', handleNavBreakpoint);
    } else {
      mobileNav.addListener(handleNavBreakpoint);
    }
  }

  const countdown = document.querySelector('[data-countdown]');
  if (countdown) {
    const target = new Date(countdown.dataset.countdown);
    const updateCountdown = () => {
      const remaining = target.valueOf() - Date.now();
      if (remaining <= 0) return;
      const days = Math.floor(remaining / 86400000);
      const hours = Math.floor((remaining % 86400000) / 3600000);
      countdown.querySelector('strong').textContent = `${days}d ${hours}h`;
    };
    updateCountdown();
    window.setInterval(updateCountdown, 60000);
  }

  // ── Dismissible feedback; errors stay until acknowledged ────
  document.querySelectorAll('.alert').forEach(alert => {
    const isUrgent = alert.classList.contains('alert--error')
      || alert.classList.contains('alert--warning');
    alert.setAttribute('role', isUrgent ? 'alert' : 'status');
    alert.setAttribute('aria-live', isUrgent ? 'assertive' : 'polite');

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'alert__dismiss';
    dismiss.textContent = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss message');
    alert.append(dismiss);

    const removeAlert = () => {
      alert.classList.add('alert--leaving');
      window.setTimeout(() => alert.remove(), 200);
    };
    dismiss.addEventListener('click', removeAlert);

    if (!alert.classList.contains('alert--success')) return;
    let timer = null;
    const stopTimer = () => {
      window.clearTimeout(timer);
      timer = null;
    };
    const startTimer = () => {
      stopTimer();
      timer = window.setTimeout(removeAlert, 8000);
    };
    alert.addEventListener('mouseenter', stopTimer);
    alert.addEventListener('mouseleave', startTimer);
    alert.addEventListener('focusin', stopTimer);
    alert.addEventListener('focusout', startTimer);
    startTimer();
  });

});
