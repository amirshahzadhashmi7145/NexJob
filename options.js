// options.js — full-tab editor for the API key and the (growing) profile JSON.
// Both are persisted to chrome.storage.local; the popup reads them at fill time.

const apiKeyEl = document.getElementById('apiKey');
const profileEl = document.getElementById('profile');
const executorEl = document.getElementById('executor');
const statusEl = document.getElementById('status');

function flash(msg, ok = true) {
  statusEl.textContent = msg;
  statusEl.style.color = ok ? '#16a34a' : '#dc2626';
  if (ok) setTimeout(() => (statusEl.textContent = ''), 2500);
}

async function load() {
  const { apiKey = '', profile = '', executorEnabled = false } = await chrome.storage.local.get([
    'apiKey', 'profile', 'executorEnabled',
  ]);
  apiKeyEl.value = apiKey;
  profileEl.value = profile;
  executorEl.checked = executorEnabled; // default off
}

document.getElementById('save').addEventListener('click', async () => {
  const profile = profileEl.value.trim();
  if (profile) {
    try {
      JSON.parse(profile);
    } catch (e) {
      flash('Profile is not valid JSON: ' + e.message, false);
      return;
    }
  }
  await chrome.storage.local.set({
    apiKey: apiKeyEl.value.trim(),
    profile,
    executorEnabled: executorEl.checked,
  });
  flash('Saved ✓');
});

document.getElementById('loadExample').addEventListener('click', async () => {
  const res = await fetch(chrome.runtime.getURL('profile.example.json'));
  profileEl.value = await res.text();
  flash('Loaded example — edit it and Save.');
});

load();
