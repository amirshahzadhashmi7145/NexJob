// popup.js
// Orchestrates one fill: scan the active tab -> ask the LLM -> write values back -> ask the
// user for anything left unfilled (text fields AND choice questions) -> remember those
// answers in the profile so next time they fill automatically. The OpenAI key never touches
// the web page: the fetch runs here, in the popup. extractFields / fillFields from inject.js.

const $ = (id) => document.getElementById(id);
const fillBtn = $('fill');
const statusEl = $('status');
const missingEl = $('missing');
const listEl = $('missingList');

let curTabId = null;

function setStatus(text, kind) {
  statusEl.className = kind || '';
  statusEl.textContent = '';
  if (kind === 'busy') {
    const s = document.createElement('span');
    s.className = 'spinner';
    statusEl.appendChild(s);
  }
  statusEl.appendChild(document.createTextNode(text));
}

$('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

fillBtn.addEventListener('click', runFill);
$('skipMissing').addEventListener('click', () => missingEl.classList.remove('show'));
$('saveMissing').addEventListener('click', saveMissing);

async function runFill() {
  missingEl.classList.remove('show');
  const { profile, apiKey } = await chrome.storage.local.get(['profile', 'apiKey']);
  if (!apiKey) return setStatus('Add your OpenAI key in settings.', 'err');
  if (!profile) return setStatus('Add your profile in settings.', 'err');

  let profileObj;
  try {
    profileObj = JSON.parse(profile);
  } catch {
    return setStatus('Profile JSON is invalid — fix it in settings.', 'err');
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return setStatus('No active tab.', 'err');
  curTabId = tab.id;

  fillBtn.disabled = true;
  try {
    setStatus('Scanning form…', 'busy');
    const [{ result: fields }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractFields,
    });
    if (!fields || !fields.length) return setStatus('No fillable fields found here.', 'err');

    setStatus('Found ' + fields.length + ' fields. Asking AI…', 'busy');
    const mappings = await mapFields(apiKey, profileObj, fields);

    if (mappings.length) {
      setStatus('Filling ' + mappings.length + ' fields…', 'busy');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: fillFields,
        args: [mappings],
      });
    }

    const mapped = new Set(mappings.map((m) => String(m.af_id)));
    const texts = fields.filter(
      (f) => isAskableText(f) && !mapped.has(String(f.af_id)) && !f.currentValue,
    );
    const groups = groupChoices(fields, mapped);

    if (texts.length || groups.length) {
      const n = texts.length + groups.length;
      setStatus('Filled ' + mappings.length + '. ' + n + ' need your input:', 'ok');
      showMissing(texts, groups);
    } else {
      setStatus('Filled ' + mappings.length + ' fields. Review, then submit.', 'ok');
    }
  } catch (err) {
    setStatus('Error: ' + (err?.message || String(err)), 'err');
  } finally {
    fillBtn.disabled = false;
  }
}

// Plain text-ish fields (not choices) worth asking about.
function isAskableText(f) {
  if (!f.label) return false;
  if (f.question !== undefined) return false; // it's a choice option — handled as a group
  return (
    f.tag === 'textarea' ||
    f.tag === 'select' ||
    f.widget ||
    ['text', 'email', 'tel', 'url', 'number', 'search', ''].includes(f.type)
  );
}

// Group choice options (radio/checkbox/switch/choice-buttons) into one question each, and
// keep only the questions the model did NOT answer.
function groupChoices(fields, mapped) {
  const byGroup = new Map();
  for (const f of fields) {
    if (f.question === undefined) continue; // only choice options carry this
    const key = f.choiceGroup || f.question || 'grp-' + f.af_id;
    if (!byGroup.has(key)) byGroup.set(key, { question: f.question || 'Choose an option', options: [] });
    byGroup.get(key).options.push({ af_id: f.af_id, option: f.option || f.label });
  }
  const out = [];
  for (const g of byGroup.values()) {
    if (!g.options.length) continue;
    if (g.options.some((o) => mapped.has(String(o.af_id)))) continue; // model already answered
    out.push(g);
  }
  return out;
}

function showMissing(texts, groups) {
  listEl.textContent = '';
  let idx = 0;

  for (const f of texts) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.style.animationDelay = idx++ * 0.04 + 's';
    const lab = document.createElement('label');
    lab.textContent = f.label;
    const long = f.tag === 'textarea' || f.label.length > 60;
    const inp = document.createElement(long ? 'textarea' : 'input');
    if (long) inp.rows = 3;
    inp.dataset.afId = f.af_id;
    inp.dataset.label = f.label;
    wrap.appendChild(lab);
    wrap.appendChild(inp);
    listEl.appendChild(wrap);
  }

  for (const g of groups) {
    const wrap = document.createElement('div');
    wrap.className = 'field group';
    wrap.style.animationDelay = idx++ * 0.04 + 's';
    const lab = document.createElement('label');
    lab.textContent = g.question;
    wrap.appendChild(lab);
    const opts = document.createElement('div');
    opts.className = 'opts';
    for (const o of g.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.textContent = o.option;
      b.dataset.afId = o.af_id;
      b.addEventListener('click', () => {
        opts.querySelectorAll('.opt').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
      });
      opts.appendChild(b);
    }
    wrap.appendChild(opts);
    listEl.appendChild(wrap);
  }

  missingEl.classList.add('show');
}

async function saveMissing() {
  const fillEntries = [];
  const learnEntries = [];

  // Text answers.
  listEl.querySelectorAll('input[data-af-id], textarea[data-af-id]').forEach((i) => {
    const v = i.value.trim();
    if (!v) return;
    fillEntries.push({ af_id: i.dataset.afId, value: v });
    learnEntries.push({ label: i.dataset.label, value: v });
  });

  // Choice selections.
  listEl.querySelectorAll('.field.group').forEach((g) => {
    const sel = g.querySelector('.opt.sel');
    if (!sel) return;
    fillEntries.push({ af_id: sel.dataset.afId, value: 'true' });
    const q = g.querySelector('label')?.textContent || '';
    learnEntries.push({ label: q, value: sel.textContent });
  });

  if (!fillEntries.length) {
    missingEl.classList.remove('show');
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: curTabId },
      func: fillFields,
      args: [fillEntries],
    });
    await remember(learnEntries);
    setStatus('Filled ' + fillEntries.length + ' more and remembered them for next time.', 'ok');
    missingEl.classList.remove('show');
  } catch (err) {
    setStatus('Error: ' + (err?.message || String(err)), 'err');
  }
}

// Persist the user's answers back into the profile under "learned", keyed by the question.
// Next run, mapFields sees them and fills automatically — this is the "learns over time" part.
async function remember(entries) {
  const { profile } = await chrome.storage.local.get('profile');
  let p;
  try {
    p = JSON.parse(profile);
  } catch {
    p = {};
  }
  p.learned = p.learned || {};
  for (const e of entries) if (e.label) p.learned[e.label] = e.value;
  await chrome.storage.local.set({ profile: JSON.stringify(p, null, 2) });
}

// Ask the LLM which value goes in each field. Structured output guarantees valid JSON.
async function mapFields(apiKey, profile, fields) {
  const system =
    "You fill web forms from a user's profile JSON. Given the profile and a list of " +
    'form fields, decide which value to put in each field.\n' +
    'Rules:\n' +
    '- Only include a field if the profile clearly provides a matching value. Omit anything uncertain.\n' +
    '- For a "select" field, value MUST be exactly one of its listed options. If none of the\n' +
    '  options matches the profile value but there is an "Other"/"Not listed" option, use that.\n' +
    '- Fields that share the same non-empty "choiceGroup" are ONE question made of radio\n' +
    '  buttons. Pick the single best option and set its value to "true"; do NOT include the\n' +
    "  group's other options in your output.\n" +
    '- For a standalone checkbox, value is "true" or "false".\n' +
    '- A field\'s label may read "Question — Option" for grouped choices; match on the whole thing.\n' +
    '- A field with "widget": true is a custom dropdown/autocomplete with no options listed.\n' +
    '  Give the best full value from the profile (e.g. the full country/state/city name); the\n' +
    '  extension opens the widget and clicks the closest match.\n' +
    '- For long free-text / essay / screening questions (textarea, or a long question label),\n' +
    '  ONLY fill from a matching pre-written answer in the profile ("answers" or "learned").\n' +
    '  Use that answer VERBATIM. Do NOT compose, rephrase, summarize, or invent prose. If no\n' +
    '  matching pre-written answer exists, OMIT the field so the user writes it themselves.\n' +
    '- The profile may include a "learned" object of past answers keyed by question — reuse\n' +
    '  them verbatim when the current field matches.\n' +
    '- Keep values concise plain text. Do not invent data that is not in the profile.';

  const body = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ profile, fields }) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'field_mappings',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['mappings'],
          properties: {
            mappings: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['af_id', 'value'],
                properties: {
                  af_id: { type: 'string' },
                  value: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error('OpenAI ' + res.status + ': ' + t.slice(0, 200));
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);
  return Array.isArray(parsed.mappings) ? parsed.mappings : [];
}
