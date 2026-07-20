/**
 * main.js — GBAGL client-side interactivity
 * Vanilla JS only, no frameworks.
 */

document.addEventListener('DOMContentLoaded', () => {

  // ── Mobile navigation toggle ────────────────────────────────
  const navToggle = document.getElementById('navToggle');
  const navLinks  = document.getElementById('navLinks');

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      navLinks.classList.toggle('nav__links--open');
      navToggle.setAttribute(
        'aria-expanded',
        navLinks.classList.contains('nav__links--open'),
      );
    });

    // Close mobile nav when a link is tapped
    navLinks.querySelectorAll('.nav__link').forEach(link => {
      link.addEventListener('click', () => {
        navLinks.classList.remove('nav__links--open');
      });
    });
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

  // ── Auto-dismiss flash alerts after 5 seconds ───────────────
  document.querySelectorAll('.alert').forEach(alert => {
    setTimeout(() => {
      alert.style.transition = 'opacity 0.5s';
      alert.style.opacity    = '0';
      setTimeout(() => alert.remove(), 500);
    }, 5000);
  });

});
