document.addEventListener('DOMContentLoaded', () => {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

  function listsFor(group) {
    return Array.from(document.querySelectorAll('[data-reorder-group]'))
      .filter((list) => list.dataset.reorderGroup === group);
  }

  function itemsFor(group) {
    return listsFor(group).flatMap(
      (list) => Array.from(list.querySelectorAll(':scope > [data-reorder-item]')),
    );
  }

  function snapshot(group) {
    return listsFor(group).map((list) => ({
      list,
      ids: Array.from(list.querySelectorAll(':scope > [data-reorder-item]'))
        .map((item) => item.dataset.reorderId),
    }));
  }

  function restore(snapshotValue) {
    const allItems = new Map();
    snapshotValue.forEach(({ list }) => {
      list.querySelectorAll(':scope > [data-reorder-item]').forEach((item) => {
        allItems.set(item.dataset.reorderId, item);
      });
    });
    snapshotValue.forEach(({ list, ids }) => {
      ids.forEach((id) => list.append(allItems.get(id)));
    });
  }

  function statusFor(group) {
    return Array.from(document.querySelectorAll('[data-reorder-status]'))
      .find((status) => status.dataset.reorderStatus === group);
  }

  function updateMoveButtons(group) {
    listsFor(group).forEach((list) => {
      const items = Array.from(list.querySelectorAll(':scope > [data-reorder-item]'));
      items.forEach((item, index) => {
        const up = item.querySelector('[data-move-direction="up"]');
        const down = item.querySelector('[data-move-direction="down"]');
        if (up) up.disabled = index === 0;
        if (down) down.disabled = index === items.length - 1;
      });
    });
  }

  function setBusy(group, busy) {
    itemsFor(group).forEach((item) => {
      item.querySelectorAll('[data-drag-handle], [data-move-direction]').forEach((control) => {
        control.disabled = busy;
      });
    });
  }

  async function persist(group, previousOrder) {
    const list = listsFor(group)[0];
    const status = statusFor(group);
    if (!list || !csrfToken) return;
    setBusy(group, true);
    if (status) status.textContent = 'Saving order...';
    try {
      const response = await fetch(list.dataset.reorderUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _csrf: csrfToken,
          ids: itemsFor(group).map((item) => item.dataset.reorderId),
        }),
      });
      if (!response.ok) throw new Error(`Order request failed with ${response.status}`);
      if (status) status.textContent = 'Order saved.';
    } catch (error) {
      console.error('Content reorder failed:', error);
      restore(previousOrder);
      if (status) status.textContent = 'Order was not saved. Please try again.';
    } finally {
      setBusy(group, false);
      updateMoveButtons(group);
    }
  }

  document.querySelectorAll('[data-reorder-toggle]').forEach((toggle) => {
    const group = toggle.dataset.reorderToggle;
    toggle.addEventListener('click', () => {
      const enabled = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', String(enabled));
      toggle.textContent = enabled
        ? 'Done reordering'
        : toggle.dataset.reorderLabel;
      listsFor(group).forEach((list) => {
        list.toggleAttribute('data-reordering', enabled);
        list.querySelectorAll('[data-reorder-controls]').forEach((controls) => {
          controls.hidden = !enabled;
        });
      });
      updateMoveButtons(group);
    });
  });

  document.querySelectorAll('[data-move-direction]').forEach((button) => {
    button.addEventListener('click', () => {
      const item = button.closest('[data-reorder-item]');
      const list = item?.parentElement;
      const group = list?.dataset.reorderGroup;
      if (!item || !list || !group) return;
      const previousOrder = snapshot(group);
      if (button.dataset.moveDirection === 'up') {
        const previous = item.previousElementSibling;
        if (previous?.matches('[data-reorder-item]')) list.insertBefore(item, previous);
      } else {
        const next = item.nextElementSibling;
        if (next?.matches('[data-reorder-item]')) list.insertBefore(next, item);
      }
      updateMoveButtons(group);
      void persist(group, previousOrder);
    });
  });

  let drag = null;
  document.querySelectorAll('[data-drag-handle]').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      if (handle.disabled || event.button > 0) return;
      const item = handle.closest('[data-reorder-item]');
      const list = item?.parentElement;
      const group = list?.dataset.reorderGroup;
      if (!item || !list || !group || !list.hasAttribute('data-reordering')) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      drag = {
        group,
        handle,
        item,
        list,
        moved: false,
        pointerId: event.pointerId,
        previousOrder: snapshot(group),
      };
      item.classList.add('is-dragging');
      item.setAttribute('aria-grabbed', 'true');
    });

    handle.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      if (event.clientY < 72) window.scrollBy(0, -12);
      if (event.clientY > window.innerHeight - 72) window.scrollBy(0, 12);
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest('[data-reorder-item]');
      if (!target || target === drag.item || target.parentElement !== drag.list) return;
      const bounds = target.getBoundingClientRect();
      if (event.clientY < bounds.top + (bounds.height / 2)) {
        drag.list.insertBefore(drag.item, target);
      } else {
        drag.list.insertBefore(drag.item, target.nextElementSibling);
      }
      drag.moved = true;
      updateMoveButtons(drag.group);
    });

    const finishDrag = (event, cancelled = false) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.item.classList.remove('is-dragging');
      drag.item.removeAttribute('aria-grabbed');
      const completed = drag;
      drag = null;
      if (cancelled) {
        restore(completed.previousOrder);
        updateMoveButtons(completed.group);
      } else if (completed.moved) {
        void persist(completed.group, completed.previousOrder);
      }
    };
    handle.addEventListener('pointerup', (event) => finishDrag(event));
    handle.addEventListener('pointercancel', (event) => finishDrag(event, true));
  });

  document.querySelectorAll('[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });

  const timelineToggle = document.querySelector('[data-timeline-edit-toggle]');
  if (timelineToggle) {
    timelineToggle.addEventListener('click', () => {
      const enabled = timelineToggle.getAttribute('aria-pressed') !== 'true';
      timelineToggle.setAttribute('aria-pressed', String(enabled));
      timelineToggle.textContent = enabled ? 'Finish editing' : 'Edit timeline';
      document.querySelectorAll('[data-timeline-edit-controls]').forEach((controls) => {
        controls.hidden = !enabled;
      });
    });
  }
});
