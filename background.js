// background.js — service worker. Message hub for the content script.
// It owns the OpenAI calls and storage so the API key never enters the page/content world.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'settings') {
        const s = await chrome.storage.local.get(['apiKey', 'profile', 'executorEnabled']);
        sendResponse({ ok: true, ...s });
      } else if (msg.type === 'map') {
        const { apiKey } = await chrome.storage.local.get('apiKey');
        sendResponse({ ok: true, mappings: await mapFields(apiKey, msg.profile, msg.fields) });
      } else if (msg.type === 'plan') {
        const { apiKey } = await chrome.storage.local.get('apiKey');
        sendResponse({ ok: true, actions: await planActions(apiKey, msg.field, msg.value, msg.html) });
      } else if (msg.type === 'remember') {
        await remember(msg.entries);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // keep the channel open for the async response
});

async function remember(entries) {
  const { profile } = await chrome.storage.local.get('profile');
  let p;
  try {
    p = JSON.parse(profile);
  } catch {
    p = {};
  }
  p.learned = p.learned || {};
  for (const e of entries || []) if (e.label) p.learned[e.label] = e.value;
  await chrome.storage.local.set({ profile: JSON.stringify(p, null, 2) });
}

// Which value goes in each field. Structured output guarantees valid JSON.
async function mapFields(apiKey, profile, fields) {
  if (!apiKey) throw new Error('No API key — add one in settings.');
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
    temperature: 0.2, // low randomness — mostly consistent run-to-run with a little flexibility
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
                properties: { af_id: { type: 'string' }, value: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  };

  const data = await callOpenAI(apiKey, body);
  const content = data.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);
  return Array.isArray(parsed.mappings) ? parsed.mappings : [];
}

// LLM planner: given ONE field's HTML + desired value, return SAFE actions (no code).
async function planActions(apiKey, field, value, html) {
  if (!apiKey) return [];
  const system =
    'You control ONE web form field using a fixed, safe set of actions. You are given the\n' +
    "field's HTML and the value to enter. Return an ordered list of actions that set it.\n" +
    'Actions (each has "action" plus some of selector/text/value; set unused ones to null):\n' +
    '- {"action":"setValue","selector":"<css>","value":"<text>"} — type into a text input/textarea.\n' +
    '- {"action":"selectOption","selector":"<css for the <select>>","text":"<option text>"} — native select.\n' +
    '- {"action":"click","selector":"<css>"} or {"action":"click","text":"<visible text>"} — click a\n' +
    '  trigger or an option. For a custom dropdown: click the trigger, then click the option by text.\n' +
    'Rules:\n' +
    '- Use CSS selectors that actually appear in the given HTML (id, class, name, data-*, role).\n' +
    '- NEVER click submit / next / continue / save / apply / upload / delete controls.\n' +
    '- Use the fewest steps. If nothing sensible fits, return an empty list.';

  const body = {
    model: 'gpt-4o-mini',
    temperature: 0.2, // low randomness — mostly consistent run-to-run with a little flexibility
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ label: field?.label, value, html }) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'action_plan',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['actions'],
          properties: {
            actions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['action', 'selector', 'text', 'value'],
                properties: {
                  action: { type: 'string', enum: ['click', 'setValue', 'selectOption'] },
                  selector: { type: ['string', 'null'] },
                  text: { type: ['string', 'null'] },
                  value: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
      },
    },
  };

  try {
    const data = await callOpenAI(apiKey, body);
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    return Array.isArray(parsed.actions) ? parsed.actions : [];
  } catch {
    return [];
  }
}

async function callOpenAI(apiKey, body) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('OpenAI ' + res.status + ': ' + t.slice(0, 200));
  }
  return res.json();
}
