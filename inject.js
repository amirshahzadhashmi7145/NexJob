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
    '[role="textbox"], [role="combobox"], [aria-haspopup="listbox"], ' +
    '[role="radio"], [role="checkbox"], [role="switch"], [aria-pressed], ' +
    // choice buttons live only inside a question group (avoids grabbing Submit/Next):
    '[role="radiogroup"] button, [role="group"] button, fieldset button, ' +
    '[role="radiogroup"] [role="button"], [role="group"] [role="button"], fieldset [role="button"]';
  const SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);

  const NATIVE = 'input, textarea, select';
  // Words that mean "this button does an action" (never a choice option).
  const ACTION_RE =
    /^(submit|next|back|prev|previous|continue|save|cancel|apply|upload|add|remove|delete|edit|search|clear|close|skip|browse|choose file|log ?in|sign ?in|sign ?up)/i;

  function isWidget(el) {
    const role = el.getAttribute('role');
    return (
      role === 'combobox' ||
      role === 'listbox' ||
      el.getAttribute('aria-haspopup') === 'listbox' ||
      el.getAttribute('aria-autocomplete') != null
    );
  }

  // The question a radio/checkbox belongs to (the group label), so the model sees the full
  // "Are you comfortable working on-site?" instead of a bare "Yes". Custom forms (Ashby,
  // Workday, Thingtrax) rarely use <fieldset>, so we also climb for a preceding question.
  function groupQuestion(el) {
    const grp = el.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (grp) {
      const legend = grp.querySelector('legend');
      if (legend && legend.textContent.trim()) return legend.textContent;
      if (grp.getAttribute('aria-label')) return grp.getAttribute('aria-label');
      if (grp.getAttribute('aria-labelledby')) {
        const l = document.getElementById(grp.getAttribute('aria-labelledby'));
        if (l && l.textContent.trim()) return l.textContent;
      }
      let p = grp.previousElementSibling;
      while (p && !p.textContent.trim()) p = p.previousElementSibling;
      if (p) return p.textContent;
    }
    // No explicit group container: the question is usually a heading/label/paragraph that
    // precedes the option cluster. Walk up a few levels and take the first real text that
    // isn't itself an option ("Yes"/"No").
    let node = el;
    for (let d = 0; d < 4 && node; d++, node = node.parentElement) {
      let p = node.previousElementSibling;
      while (p) {
        const t = p.textContent.replace(/\s+/g, ' ').trim();
        if (t && !/^(yes|no|true|false)$/i.test(t)) return t;
        p = p.previousElementSibling;
      }
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
    // For custom (non-native) widgets, the element's own text is often the option label,
    // e.g. <div role="radio">Yes</div>.
    if (!label && !el.matches(NATIVE)) label = el.textContent || '';
    if (!label) {
      const prev = el.previousElementSibling;
      if (prev) label = prev.textContent || '';
    }
    return label;
  }

  function isChoice(el) {
    const t = (el.getAttribute('type') || '').toLowerCase();
    const r = el.getAttribute('role');
    if (t === 'radio' || t === 'checkbox' || r === 'radio' || r === 'checkbox' || r === 'switch') return true;
    if (el.hasAttribute('aria-pressed')) return true;
    // A button / role=button inside a question group, that isn't an action button.
    if ((el.tagName === 'BUTTON' || r === 'button') && el.closest('[role="radiogroup"], [role="group"], fieldset')) {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return txt.length > 0 && txt.length <= 40 && !ACTION_RE.test(txt);
    }
    return false;
  }

  // The SHORT label for one choice option ("Yes"), distinct from the group's question.
  // Many forms give the radio's accessible name as the whole question, so we gather several
  // candidates and take the shortest one that isn't the question.
  function optionLabel(el, q) {
    const nq = (q || '').replace(/\s+/g, ' ').trim();
    const cands = [];
    if (!el.matches(NATIVE)) cands.push(el.textContent);
    if (el.labels && el.labels[0]) cands.push(el.labels[0].textContent);
    const wrap = el.closest('label');
    if (wrap) cands.push(wrap.textContent);
    cands.push(el.getAttribute('aria-label'));
    if (el.nextElementSibling) cands.push(el.nextElementSibling.textContent);
    if (el.previousElementSibling) cands.push(el.previousElementSibling.textContent);
    cands.push(el.value);
    let best = '';
    for (let c of cands) {
      if (!c) continue;
      c = c.replace(/\s+/g, ' ').trim();
      if (nq && c.includes(nq)) c = c.replace(nq, '').replace(/^[\s\-—–:*|]+/, '').trim();
      if (!c || c === nq) continue;
      if (!best || c.length < best.length) best = c; // shortest wins ("Yes" over the question)
    }
    return best || (el.value || '').trim();
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
    const choice = isChoice(el);
    if (SKIP.has(type) && !choice) continue; // keep choice-buttons; drop Submit/Next/etc.
    if (el.disabled || el.readOnly) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue; // invisible

    const afId = String(i++);
    el.setAttribute('data-af-id', afId);

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';

    let label = resolveLabel(el);
    let q = '';
    let own = '';
    if (choice) {
      q = groupQuestion(el).replace(/\s+/g, ' ').trim();
      own = optionLabel(el, q); // "Yes"/"No", not the whole question
      label = q ? q + ' — ' + own : own;
    }
    label = label.replace(/\s+/g, ' ').trim().slice(0, choice ? 300 : 200);

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
      // A custom choice widget's own text is the option, not a "current value".
      currentValue: (el.value || (choice ? '' : el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    };

    if (choice) {
      const grp = el.closest('[role="radiogroup"], fieldset, [role="group"]');
      // Group key so the model (and the popup) treat one question's options as one choice.
      field.choiceGroup = el.getAttribute('name') || (grp && grp.id) || q || '';
      field.optionValue = el.value || own || '';
      field.question = q; // the group's question (may be '')
      field.option = own; // this option's own label ("Yes", "No", ...)
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
  // Fallback option to pick when the profile's value isn't among the choices.
  const OTHER_RE = /(^|\W)other(\W|$)|not listed|none of the above|prefer not|please specify/i;

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
    const pick = (list) =>
      list.find((o) => norm(o.textContent) === norm(value)) ||
      list.find((o) => norm(o.textContent).startsWith(norm(value))) ||
      list.find((o) => norm(o.textContent).includes(norm(value)));

    let opts = await waitForOptions(2500);
    let match = pick(opts);

    // The typed text may have filtered the list to nothing. If there WERE options (so this
    // is a real dropdown, not a free-text box), clear the filter so all options — including
    // an "Other" — come back, then re-pick.
    if (!match && opts.length && el.tagName === 'INPUT') {
      setNativeValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      opts = await waitForOptions(1200);
      match = pick(opts);
    }
    // Value not in the list but an "Other"/"Not listed" option exists → pick that.
    if (!match) match = opts.find((o) => OTHER_RE.test(norm(o.textContent)));

    if (match) {
      match.scrollIntoView({ block: 'nearest' });
      match.click();
      return true;
    }
    // No match at all: keep the typed value (free-text autocompletes accept it) and close
    // any open list GENTLY by blurring. Never press Escape/Enter — those bubble to the page
    // and can close the whole modal (e.g. LinkedIn Easy Apply's "Save application?") or
    // submit the form.
    el.blur();
    return el.tagName === 'INPUT';
  }

  const filledIds = [];

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
    let ok = false;

    try {
      if (tag === 'select') {
        const opts = Array.from(el.options);
        let match =
          opts.find((o) => o.value === value) ||
          opts.find((o) => norm(o.textContent) === norm(value)) ||
          opts.find((o) => norm(o.textContent).includes(norm(value)));
        // Value not listed but an "Other"/"Not listed" option exists → pick that.
        if (!match) {
          match = opts.find((o) => OTHER_RE.test(norm(o.textContent)) || OTHER_RE.test(norm(o.value)));
        }
        if (match) { el.value = match.value; fireInput(el); ok = true; }
      } else if (
        type === 'checkbox' || type === 'radio' ||
        role === 'radio' || role === 'checkbox' || role === 'switch' ||
        el.hasAttribute('aria-pressed') || tag === 'button' || role === 'button'
      ) {
        const native = type === 'checkbox' || type === 'radio';
        const desired = /^(true|yes|on|1|checked|selected)$/i.test(value.trim());
        let current = false;
        if (native) current = el.checked;
        else if (el.hasAttribute('aria-checked')) current = el.getAttribute('aria-checked') === 'true';
        else if (el.hasAttribute('aria-pressed')) current = el.getAttribute('aria-pressed') === 'true';
        // Click to change state (fires native events). Only ever click to turn ON — the
        // model / user picks one option, and we never toggle another off.
        if (current !== desired && (desired || native)) el.click();
        ok = true;
      } else if (isWidget) {
        ok = await fillWidget(el, value);
      } else if (el.isContentEditable) {
        el.textContent = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        ok = true;
      } else {
        setNativeValue(el, value);
        fireInput(el);
        ok = true;
      }
      if (ok) {
        el.style.outline = '2px solid #22c55e'; // green highlight so the user can eyeball
        filledIds.push(String(m.af_id));
      }
    } catch (e) {
      // One stubborn field shouldn't abort the rest.
    }
  }

  return filledIds;
}

// Return the outerHTML of a field's surrounding container, so the LLM planner can see the
// widget's structure. Capped so we never ship a huge blob.
function getFieldHTML(afId) {
  const el = document.querySelector('[data-af-id="' + CSS.escape(String(afId)) + '"]');
  if (!el) return '';
  let c = el;
  // Climb a few levels for context, but stop before we swallow the whole form.
  for (let i = 0; i < 3; i++) {
    const p = c.parentElement;
    if (!p || p.querySelectorAll('input, textarea, select, [role]').length > 14) break;
    c = p;
  }
  return c.outerHTML.slice(0, 4000);
}

// SAFE EXECUTOR: run a small, fixed set of actions the LLM planned for a tricky field.
// It executes ONLY these whitelisted primitives — it never evals code. Each action refers
// to elements by CSS selector or visible text. Returns how many steps applied.
async function runActions(actions) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const q = (sel) => {
    try {
      return Array.from(document.querySelectorAll(sel)).filter(vis);
    } catch {
      return [];
    }
  };
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  const byText = (text) => {
    const t = norm(text);
    const cands = document.querySelectorAll(
      'button, [role="option"], [role="radio"], [role="button"], label, li, a, span, div',
    );
    return Array.from(cands).filter(vis).find((e) => norm(e.textContent) === t);
  };
  const setVal = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  let done = 0;
  for (const a of actions || []) {
    try {
      if (a.action === 'click') {
        const el = (a.selector && q(a.selector)[0]) || (a.text && byText(a.text));
        if (el) { el.scrollIntoView({ block: 'nearest' }); el.click(); done++; }
      } else if (a.action === 'setValue') {
        const el = a.selector && q(a.selector)[0];
        if (el) { el.focus(); setVal(el, a.value != null ? a.value : a.text); done++; }
      } else if (a.action === 'selectOption') {
        const el = a.selector && q(a.selector)[0];
        if (el && el.tagName === 'SELECT') {
          const o = Array.from(el.options).find(
            (o) => norm(o.textContent) === norm(a.text) || o.value === a.value,
          );
          if (o) { el.value = o.value; el.dispatchEvent(new Event('change', { bubbles: true })); done++; }
        }
      }
      await sleep(160); // let async widgets react between steps
    } catch (e) {
      // skip a bad step, keep going
    }
  }
  return done;
}
