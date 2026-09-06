// popup.js
// Orchestrates one fill: scan the active tab -> ask the LLM -> write values back.
// The OpenAI key never touches the web page — the fetch runs here, in the extension popup.
// extractFields / fillFields come from inject.js (loaded before this script).

const statusEl = document.getElementById('status');
const setStatus = (m) => { statusEl.textContent = m; };

document.getElementById('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById('fill').addEventListener('click', async () => {
  try {
    const { profile, apiKey } = await chrome.storage.local.get(['profile', 'apiKey']);
    if (!apiKey) return setStatus('No API key. Open options and add one.');
    if (!profile) return setStatus('No profile. Open options and add your data.');

    let profileObj;
    try {
      profileObj = JSON.parse(profile);
    } catch {
      return setStatus('Profile JSON is invalid — fix it in options.');
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return setStatus('No active tab.');

    setStatus('Scanning form…');
    const [{ result: fields }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractFields,
    });
    if (!fields || fields.length === 0) return setStatus('No fillable fields found here.');

    setStatus('Found ' + fields.length + ' fields. Asking AI…');
    const mappings = await mapFields(apiKey, profileObj, fields);
    if (!mappings.length) return setStatus('AI found nothing to fill.');

    setStatus('Filling ' + mappings.length + ' fields…');
    const [{ result: filled }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillFields,
      args: [mappings],
    });
    setStatus('Filled ' + filled + ' fields. Review, then submit yourself.');
  } catch (err) {
    setStatus('Error: ' + (err?.message || String(err)));
  }
});

// Ask the LLM which value goes in each field. Structured output guarantees valid JSON.
async function mapFields(apiKey, profile, fields) {
  const system =
    "You fill web forms from a user's profile JSON. Given the profile and a list of " +
    'form fields, decide which value to put in each field.\n' +
    'Rules:\n' +
    '- Only include a field if the profile clearly provides a matching value. Omit anything uncertain.\n' +
    '- For a "select" field, value MUST be exactly one of its listed options.\n' +
    '- For a checkbox/radio field, value should be "true" or "false".\n' +
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
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
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
