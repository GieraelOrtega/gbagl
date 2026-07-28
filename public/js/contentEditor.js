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

  function itemLabel(item) {
    const label = item.querySelector('[data-drag-handle]')?.getAttribute('aria-label');
    return label
      ? label.replace(/^Drag\s+/, '').replace(/\s+to a new position$/, '')
      : 'Item';
  }

  function itemPosition(group, item) {
    const items = itemsFor(group);
    return `${itemLabel(item)} is now position ${items.indexOf(item) + 1} of ${items.length}.`;
  }

  function syncDisabledState(control) {
    if (
      control.hasAttribute('data-reorder-boundary')
      || control.hasAttribute('data-reorder-busy')
    ) {
      control.setAttribute('aria-disabled', 'true');
    } else {
      control.removeAttribute('aria-disabled');
    }
  }

  function updateMoveButtons(group) {
    listsFor(group).forEach((list) => {
      const items = Array.from(list.querySelectorAll(':scope > [data-reorder-item]'));
      items.forEach((item, index) => {
        const up = item.querySelector('[data-move-direction="up"]');
        const down = item.querySelector('[data-move-direction="down"]');
        if (up) {
          up.toggleAttribute('data-reorder-boundary', index === 0);
          syncDisabledState(up);
        }
        if (down) {
          down.toggleAttribute('data-reorder-boundary', index === items.length - 1);
          syncDisabledState(down);
        }
      });
    });
  }

  function setBusy(group, busy) {
    itemsFor(group).forEach((item) => {
      item.querySelectorAll('[data-drag-handle], [data-move-direction]').forEach((control) => {
        control.toggleAttribute('data-reorder-busy', busy);
        syncDisabledState(control);
      });
    });
  }

  async function persist(group, previousOrder, feedback = {}) {
    const list = listsFor(group)[0];
    const status = statusFor(group);
    if (!list || !csrfToken) return false;
    let saved = false;
    setBusy(group, true);
    if (status) status.textContent = feedback.saving || 'Saving order...';
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
      saved = true;
      if (status) status.textContent = feedback.saved || 'Order saved.';
    } catch (error) {
      console.error('Content reorder failed:', error);
      restore(previousOrder);
      if (status) status.textContent = 'Order was not saved. Please try again.';
    } finally {
      setBusy(group, false);
      updateMoveButtons(group);
    }
    return saved;
  }

  document.querySelectorAll('[data-reorder-toggle]').forEach((toggle) => {
    const group = toggle.dataset.reorderToggle;
    toggle.addEventListener('click', () => {
      const enabled = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', String(enabled));
      toggle.setAttribute('aria-expanded', String(enabled));
      toggle.textContent = enabled
        ? 'Done reordering'
        : toggle.dataset.reorderLabel;
      listsFor(group).forEach((list) => {
        list.toggleAttribute('data-reordering', enabled);
        list.querySelectorAll('[data-reorder-controls]').forEach((controls) => {
          controls.hidden = !enabled;
        });
      });
      const status = statusFor(group);
      if (status) {
        status.textContent = enabled
          ? 'Reordering enabled. Drag items or use Up and Down; changes save automatically.'
          : 'Reordering finished.';
      }
      updateMoveButtons(group);
    });
  });

  document.querySelectorAll('[data-move-direction]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
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
      const position = itemPosition(group, item);
      void persist(group, previousOrder, {
        saving: `${position} Saving order...`,
        saved: `${position} Order saved.`,
      }).then((saved) => {
        const oppositeDirection = button.dataset.moveDirection === 'up' ? 'down' : 'up';
        const focusTarget = saved && button.getAttribute('aria-disabled') === 'true'
          ? item.querySelector(`[data-move-direction="${oppositeDirection}"]`)
          : button;
        focusTarget?.focus({ preventScroll: true });
      });
    });
  });

  let drag = null;
  function cancelActiveDrag() {
    if (!drag) return false;
    const completed = drag;
    drag = null;
    completed.item.classList.remove('is-dragging');
    completed.item.removeAttribute('aria-grabbed');
    if (completed.handle.hasPointerCapture?.(completed.pointerId)) {
      completed.handle.releasePointerCapture(completed.pointerId);
    }
    restore(completed.previousOrder);
    updateMoveButtons(completed.group);
    const status = statusFor(completed.group);
    if (status) status.textContent = 'Move canceled.';
    return true;
  }

  document.querySelectorAll('[data-drag-handle]').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      if (handle.disabled || handle.hasAttribute('data-reorder-busy') || event.button > 0) return;
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
      const status = statusFor(group);
      if (status) status.textContent = `Moving ${itemLabel(item)}.`;
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
      if (cancelled) {
        cancelActiveDrag();
        return;
      }
      drag.item.classList.remove('is-dragging');
      drag.item.removeAttribute('aria-grabbed');
      const completed = drag;
      drag = null;
      if (completed.moved) {
        const position = itemPosition(completed.group, completed.item);
        void persist(completed.group, completed.previousOrder, {
          saving: `${position} Saving order...`,
          saved: `${position} Order saved.`,
        });
      } else {
        const status = statusFor(completed.group);
        if (status) status.textContent = 'Item was not moved.';
      }
    };
    handle.addEventListener('pointerup', (event) => finishDrag(event));
    handle.addEventListener('pointercancel', (event) => finishDrag(event, true));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    cancelActiveDrag();
    const activeToggle = Array.from(document.querySelectorAll('[data-reorder-toggle]'))
      .find((toggle) => toggle.getAttribute('aria-pressed') === 'true');
    if (activeToggle) {
      activeToggle.click();
      activeToggle.focus();
    }
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
      timelineToggle.setAttribute('aria-expanded', String(enabled));
      timelineToggle.textContent = enabled ? 'Finish editing' : 'Edit timeline';
      document.querySelectorAll('[data-timeline-edit-controls]').forEach((controls) => {
        controls.hidden = !enabled;
      });
    });
  }
});
