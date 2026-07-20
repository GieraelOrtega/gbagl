document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('passcodeForm');
  const input = document.getElementById('passcodeInput');
  const dots = Array.from(document.querySelectorAll('.passcode__dot'));
  const message = document.getElementById('passcodeMessage');
  let submitting = false;

  if (!form || !input) return;

  function render() {
    input.value = input.value.replace(/\D/g, '').slice(0, 4);
    dots.forEach((dot, index) => {
      dot.classList.toggle('passcode__dot--filled', index < input.value.length);
    });
    if (message.textContent.trim()) message.textContent = '';
  }

  function submitWhenComplete() {
    if (input.value.length === 4 && !submitting) {
      submitting = true;
      form.requestSubmit();
    }
  }

  document.querySelectorAll('[data-digit]').forEach(key => {
    key.addEventListener('click', () => {
      if (input.value.length >= 4) return;
      input.value += key.dataset.digit;
      render();
      submitWhenComplete();
    });
  });

  document.getElementById('passcodeDelete')?.addEventListener('click', () => {
    input.value = input.value.slice(0, -1);
    render();
  });

  input.addEventListener('input', () => {
    render();
    submitWhenComplete();
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
});
