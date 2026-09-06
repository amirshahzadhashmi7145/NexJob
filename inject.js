// inject.js
// These two functions run INSIDE the target web page (via chrome.scripting.executeScript).
// They are also loaded by popup.html (so popup.js can reference them by name) and by
// test-form.html (for the self-check). They must be SELF-CONTAINED: chrome.scripting
// serializes only the named function, so every helper is nested inside it. No imports,
// no closures over module scope — only the DOM and standard browser globals.

// Scan the page for fillable form fields and return a plain-data descriptor for each.
// Stamps every field with data-af-id="n" so fillFields can target it later.
function extractFields() {
  const SELECTOR =
    'input, textarea, select, [contenteditable="true"], ' +
    '[role="textbox"], [role="combobox"], [aria-haspopup="listbox"]';
  const SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);

  function isWidget(el) {
    const role = el.getAttribute('role');
    return (
      role === 'combobox' ||
      role === 'listbox' ||
      el.getAttribute('aria-haspopup') === 'listbox' ||
      el.getAttribute('aria-autocomplete') != null
    );
  }

  // The question a radio/checkbox belongs to (the group label), so the model sees
  // "Willing to relocate?" instead of a bare "Yes".
  function groupQuestion(el) {
    const fs = el.closest('fieldset');
    const legend = fs && fs.querySelector('legend');
    if (legend && legend.textContent.trim()) return legend.textContent;
    const grp = el.closest('[role="radiogroup"], [role="group"]');
    if (grp && grp.getAttribute('aria-label')) return grp.getAttribute('aria-label');
    if (grp && grp.getAttribute('aria-labelledby')) {
      const l = document.getElementById(grp.getAttribute('aria-labelledby'));
      if (l) return l.textContent;
    }
    return '';
  }

  function resolveLabel(el) {
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
    if (!label && el.getAttribute('aria-labelledby')) {
      const l = document.getElementById(el.getAttribute('aria-labelledby'));
      if (l) label = l.textContent || '';
    }
    if (!label) label = el.getAttribute('placeholder') || '';
    if (!label) {
      const prev = el.previousElementSibling;
      if (prev) label = prev.textContent || '';
    }
    return label;
  }

  // If a modal/dialog is open (LinkedIn Easy Apply, most apply-in-place forms), scan ONLY
  // inside it — otherwise we'd also grab the search bar / filters on the page behind it.
  function pickRoot() {
    const dialogs = Array.from(
      document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]'),
    ).filter((d) => {
      const r = d.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!dialogs.length) return document;
    // The dialog with the most fields is the form the user means (ignores nav/search behind).
    const best = dialogs
      .map((d) => ({ d, n: d.querySelectorAll('input, textarea, select, [role="combobox"]').length }))
      .sort((a, b) => b.n - a.n)[0];
    return best.n > 0 ? best.d : document;
  }

  const root = pickRoot();
  const fields = [];
  const seen = new Set();
  let i = 0;

  for (const el of root.querySelectorAll(SELECTOR)) {
    if (seen.has(el)) continue; // one element can match the selector twice
    seen.add(el);

    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (SKIP.has(type)) continue;
    if (el.disabled || el.readOnly) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue; // invisible

    const afId = String(i++);
    el.setAttribute('data-af-id', afId);

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const isChoice = type === 'radio' || type === 'checkbox';

    let label = resolveLabel(el);
    if (isChoice) {
      const q = groupQuestion(el).replace(/\s+/g, ' ').trim();
      const own = label.replace(/\s+/g, ' ').trim() || el.value || '';
      label = q ? q + ' — ' + own : own;
    }
    label = label.replace(/\s+/g, ' ').trim().slice(0, 200);

    const field = {
      af_id: afId,
      tag,
      type,
      role,
      widget: tag !== 'select' && isWidget(el), // custom dropdown / autocomplete
      name: el.getAttribute('name') || '',
      id: el.id || '',
      label,
      required: el.required || el.getAttribute('aria-required') === 'true',
      currentValue: (el.value || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    };

    if (isChoice) {
      field.choiceGroup = el.getAttribute('name') || '';
      field.optionValue = el.value;
    }

    if (tag === 'select') {
      field.options = Array.from(el.options)
        .map((o) => (o.value || o.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 60);
    }

    fields.push(field);
  }

  return fields;
}

// Apply the AI's field->value mappings to the page. Handles native controls directly and
// custom dropdown/autocomplete widgets by opening them, waiting for options, and clicking
// the match. Async: chrome.scripting.executeScript awaits the returned promise.
// Never submits.
//
// ponytail: the widget path targets the STANDARD ARIA combobox/listbox pattern (role=option
// in an opened listbox, portal-rendered lists included). Bespoke widgets that don't emit
// role="option" may need a per-site selector added to openOptions() — upgrade there.
async function fillFields(mappings) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // React/Vue override the value setter; set through the prototype so the change "sticks".
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fireInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function openOptions() {
    let opts = Array.from(document.querySelectorAll('[role="option"]')).filter(visible);
    if (!opts.length) {
      opts = Array.from(
        document.querySelectorAll('[role="listbox"] li, ul[role="listbox"] li, .select__option'),
      ).filter(visible);
    }
    return opts;
  }

  async function waitForOptions(timeout) {
    const start = Date.now();
    let opts = [];
    while (Date.now() - start < timeout) {
      opts = openOptions();
      if (opts.length) return opts;
      await sleep(80);
    }
    return opts;
  }

  async function fillWidget(el, value) {
    el.focus();
    el.click(); // open the dropdown
    // Autocomplete text inputs need the value typed to trigger suggestions.
    if (el.tagName === 'INPUT') {
      setNativeValue(el, value);
      fireInput(el);
    } else if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const opts = await waitForOptions(2500);
    const match =
      opts.find((o) => norm(o.textContent) === norm(value)) ||
      opts.find((o) => norm(o.textContent).startsWith(norm(value))) ||
      opts.find((o) => norm(o.textContent).includes(norm(value)));
    if (match) {
      match.scrollIntoView({ block: 'nearest' });
      match.click();
      return true;
    }
    // No match: keep the typed value (free-text autocompletes accept it) and close any
    // open list GENTLY by blurring. Never press Escape/Enter — those bubble to the page
    // and can close the whole modal (e.g. LinkedIn Easy Apply's "Save application?") or
    // submit the form.
    el.blur();
    return el.tagName === 'INPUT';
  }

  let filled = 0;

  for (const m of mappings) {
    const el = document.querySelector('[data-af-id="' + CSS.escape(String(m.af_id)) + '"]');
    if (!el) continue;

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role') || '';
    const isWidget =
      role === 'combobox' ||
      role === 'listbox' ||
      el.getAttribute('aria-haspopup') === 'listbox' ||
      el.getAttribute('aria-autocomplete') != null;
    const value = String(m.value);

    try {
      if (tag === 'select') {
        const opts = Array.from(el.options);
        const match =
          opts.find((o) => o.value === value) ||
          opts.find((o) => norm(o.textContent) === norm(value)) ||
          opts.find((o) => norm(o.textContent).includes(norm(value)));
        if (!match) continue;
        el.value = match.value;
        fireInput(el);
      } else if (type === 'checkbox' || type === 'radio') {
        const desired = /^(true|yes|on|1|checked|selected)$/i.test(value.trim());
        if (el.checked !== desired) el.click(); // click flips + fires native events
      } else if (isWidget) {
        await fillWidget(el, value);
      } else if (el.isContentEditable) {
        el.textContent = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        setNativeValue(el, value);
        fireInput(el);
      }
      el.style.outline = '2px solid #22c55e'; // green highlight so the user can eyeball
      filled++;
    } catch (e) {
      // One stubborn field shouldn't abort the rest.
    }
  }

  return filled;
}
