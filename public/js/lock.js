document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('passcodeForm');
  const input = document.getElementById('passcodeInput');
  const dots = Array.from(document.querySelectorAll('.passcode__dot'));
  const message = document.getElementById('passcodeMessage');
  const policy = document.getElementById('passcodePolicy');
  let submitting = false;

  if (!form || !input) return;

  function setLockedOut(lockedOut) {
    input.disabled = lockedOut;
    form.querySelectorAll('[data-digit], #passcodeDelete, .passcode__submit').forEach((control) => {
      control.disabled = lockedOut;
    });
  }

  function initializeLockoutCountdown() {
    const lockoutUntil = Number(policy?.dataset.lockoutUntil);
    const countdown = policy?.querySelector('[data-lockout-countdown]');
    if (!lockoutUntil || !countdown) return;
    const update = () => {
      const remaining = Math.max(0, lockoutUntil - Date.now());
      if (remaining === 0) {
        setLockedOut(false);
        policy.textContent = 'You can try again now. Five incorrect attempts pause entry for 15 minutes.';
        return false;
      }
      const totalSeconds = Math.ceil(remaining / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = String(totalSeconds % 60).padStart(2, '0');
      countdown.textContent = `${minutes}:${seconds}`;
      return true;
    };
    if (!update()) return;
    const timer = window.setInterval(() => {
      if (!update()) window.clearInterval(timer);
    }, 1000);
  }

  function render(clearMessage = false) {
    input.value = input.value.replace(/\D/g, '').slice(0, 4);
    dots.forEach((dot, index) => {
      dot.classList.toggle('passcode__dot--filled', index < input.value.length);
    });
    if (clearMessage && message.textContent.trim()) message.textContent = '';
  }

  function submitWhenComplete() {
    if (input.value.length === 4 && !submitting) {
      submitting = true;
      form.requestSubmit();
    }
  }

  document.querySelectorAll('[data-digit]').forEach(key => {
    key.addEventListener('click', () => {
      if (input.disabled || input.value.length >= 4) return;
      input.value += key.dataset.digit;
      render(true);
      submitWhenComplete();
    });
  });

  document.getElementById('passcodeDelete')?.addEventListener('click', () => {
    if (input.disabled) return;
    input.value = input.value.slice(0, -1);
    render(true);
  });

  input.addEventListener('input', () => {
    render(true);
    submitWhenComplete();
  });

  document.addEventListener('keydown', (event) => {
    if (input.disabled || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^\d$/.test(event.key)) {
      event.preventDefault();
      if (input.value.length < 4) input.value += event.key;
      render(true);
      submitWhenComplete();
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      input.value = input.value.slice(0, -1);
      render(true);
    }
  });

  form.addEventListener('submit', event => {
    if (input.value.length !== 4) {
      event.preventDefault();
      submitting = false;
      message.textContent = 'Enter all four digits.';
      input.focus();
    }
  });

  render();
  initializeLockoutCountdown();
});
