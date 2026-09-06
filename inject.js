// inject.js
// These two functions run INSIDE the target web page (via chrome.scripting.executeScript).
// They are also loaded by popup.html (so popup.js can reference them by name) and by
// test-form.html (for the self-check). They must not depend on anything outside the page:
// no imports, no closures — only the DOM and standard browser globals.

// Scan the page for fillable form fields and return a plain-data descriptor for each.
// Stamps every field with data-af-id="n" so fillFields can target it later.
function extractFields() {
  const SKIP = new Set([
    'hidden', 'submit', 'button', 'reset', 'image', 'password', 'file', 'search',
  ]);
  const els = document.querySelectorAll('input, textarea, select');
  const fields = [];
  let i = 0;

  for (const el of els) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (SKIP.has(type)) continue;
    if (el.disabled || el.readOnly) continue;

    // Skip invisible fields.
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const afId = String(i++);
    el.setAttribute('data-af-id', afId);

    // Resolve a human-readable label, best source first.
    let label = '';
    if (el.labels && el.labels.length) label = el.labels[0].textContent || '';
    if (!label && el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) label = l.textContent || '';
    }
    if (!label) {
      const wrap = el.closest('label');
      if (wrap) label = wrap.textContent || '';
    }
    if (!label) label = el.getAttribute('aria-label') || '';
    if (!label) label = el.getAttribute('placeholder') || '';
    if (!label) {
      const prev = el.previousElementSibling;
      if (prev) label = prev.textContent || '';
    }
    label = label.replace(/\s+/g, ' ').trim().slice(0, 200);

    const field = {
      af_id: afId,
      tag: el.tagName.toLowerCase(),
      type,
      name: el.getAttribute('name') || '',
      id: el.id || '',
      label,
      currentValue: (el.value || '').slice(0, 100),
    };

    if (el.tagName.toLowerCase() === 'select') {
      field.options = Array.from(el.options)
        .map((o) => (o.value || o.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 60);
    }

    fields.push(field);
  }

  return fields;
}

// Apply the AI's field->value mappings to the page. Fires input+change events so
// framework-managed forms (React/Vue/Angular) register the change. Never submits.
function fillFields(mappings) {
  let filled = 0;

  for (const m of mappings) {
    const el = document.querySelector('[data-af-id="' + CSS.escape(String(m.af_id)) + '"]');
    if (!el) continue;

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (tag === 'select') {
      const opts = Array.from(el.options);
      const want = String(m.value);
      const match =
        opts.find((o) => o.value === want) ||
        opts.find((o) => (o.textContent || '').trim() === want) ||
        opts.find((o) => (o.textContent || '').trim().toLowerCase() === want.toLowerCase());
      if (!match) continue;
      el.value = match.value;
    } else if (type === 'checkbox' || type === 'radio') {
      el.checked = /^(true|yes|on|1|checked)$/i.test(String(m.value).trim());
    } else {
      el.value = m.value;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.style.outline = '2px solid #22c55e'; // green highlight so the user can eyeball
    filled++;
  }

  return filled;
}
