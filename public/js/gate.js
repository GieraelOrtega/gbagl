document.addEventListener('DOMContentLoaded', () => {
  const gate = document.querySelector('.gate');
  const heartsContainer = document.getElementById('gateHearts');
  const unlockForm = document.getElementById('unlockForm');
  const unlockButton = document.getElementById('unlockButton');

  if (!gate || !heartsContainer) return;

  function triggerHearts() {
    gate.classList.add('gate--animating');

    for (let i = 0; i < 18; i += 1) {
      const heart = document.createElement('span');
      heart.className = 'gate-hearts__heart';
      heart.textContent = Math.random() > 0.35 ? '💕' : '💗';
      heart.style.left = `${Math.random() * 100}%`;
      heart.style.animationDelay = `${Math.random() * 0.35}s`;
      heart.style.animationDuration = `${1.2 + Math.random() * 0.9}s`;
      heartsContainer.appendChild(heart);

      setTimeout(() => heart.remove(), 2500);
    }

    setTimeout(() => gate.classList.remove('gate--animating'), 900);
  }

  if (window.GATE_TRIGGER_ANIMATION) {
    triggerHearts();
  }

  if (unlockForm) {
    unlockForm.addEventListener('submit', () => {
      triggerHearts();
      if (unlockButton) {
        unlockButton.disabled = true;
        unlockButton.textContent = 'Checking... 💕';
      }
    });
  }
});
