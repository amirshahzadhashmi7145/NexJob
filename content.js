// content.js — injects a floating NexJob button on every page and runs the whole fill flow
// in-page, so you never open the popup. It has direct DOM access, so it calls extractFields /
// fillFields / getFieldHTML / runActions (from inject.js, loaded before this) directly, and
// messages the background worker for the OpenAI calls (the API key stays out of the page).

(function () {
  if (window.__nexjob) return; // avoid double-injection
  window.__nexjob = true;

  // True while this content script is still connected to the extension. After the extension
  // is reloaded/updated, old content scripts on open tabs become "orphaned" — chrome.runtime.id
  // goes undefined and any chrome.* call fails (the chrome-extension://invalid/ console spam).
  const alive = () => !!(chrome.runtime && chrome.runtime.id);

  const send = (msg) =>
    new Promise((resolve) => {
      if (!alive()) return resolve({ ok: false, error: 'Extension was updated — refresh this page.' });
      try {
        chrome.runtime.sendMessage(msg, (r) =>
          resolve(r || { ok: false, error: chrome.runtime.lastError?.message || 'no response' }),
        );
      } catch {
        resolve({ ok: false, error: 'Extension was updated — refresh this page.' });
      }
    });

  // ---- UI (shadow DOM) ---------------------------------------------------
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  // Use !important so page CSS can't override our positioning/stacking.
  const hostStyle = {
    position: 'fixed', top: '0', left: '0', width: '0', height: '0', 'z-index': '2147483647',
  };
  for (const k in hostStyle) host.style.setProperty(k, hostStyle[k], 'important');
  document.documentElement.appendChild(host);

  // Modals (LinkedIn Easy Apply, etc.) inject a top-level node AFTER us and, at the same
  // max z-index, win on DOM order — hiding/blocking our button. Keep our host the LAST
  // element in <html> so it always stays clickable above late-added overlays. The interval
  // covers libraries that re-append their own modal after us.
  // Zero recurring work: append the host ONCE and never observe/poll the page. No timers,
  // no MutationObserver — so even if this script is ever orphaned by an extension reload,
  // there is nothing running to loop or spam errors. (If a SPA later removes our node, the
  // button just disappears until the next page load — an acceptable trade for never hanging.)

  // Re-assert as the last element of <html> so we paint above modals opened after us. Called
  // ONLY on user actions (fill click, panel open) — event-driven, never on a loop.
  function bringToTop() {
    try {
      if (host.isConnected && document.documentElement.lastElementChild !== host) {
        document.documentElement.appendChild(host);
      } else if (!host.isConnected) {
        document.documentElement.appendChild(host);
      }
    } catch {}
  }

  shadow.innerHTML = `
    <style>
      @keyframes nj-spin { to { transform: rotate(360deg); } }
      @keyframes nj-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      .fab {
        position: fixed; top: 78px; right: 20px; height: 40px; padding: 0 18px; border: 0;
        border-radius: 999px; cursor: pointer; color: #fff; font: 600 13px system-ui, sans-serif;
        background: linear-gradient(135deg, #6366f1, #2563eb); box-shadow: 0 6px 18px rgba(37,99,235,.4);
        display: inline-flex; align-items: center; gap: 8px; white-space: nowrap;
        transition: transform .18s, box-shadow .18s, filter .18s; letter-spacing: .2px;
      }
      .fab:hover { transform: translateY(-1px); box-shadow: 0 10px 24px rgba(37,99,235,.52); filter: brightness(1.05); }
      .fab.busy { pointer-events: none; }
      .fab .bolt { font-size: 15px; line-height: 1; animation: floaty 3.5s ease-in-out infinite; }
      .fab.busy .bolt { display: none; }
      .fab .ring { display: none; width: 15px; height: 15px; border: 2px solid rgba(255,255,255,.5);
        border-top-color: #fff; border-radius: 50%; animation: nj-spin .7s linear infinite; }
      .fab.busy .ring { display: inline-block; }
      @keyframes floaty { 0%, 100% { transform: none; } 50% { transform: translateY(-1.5px); } }
      .toast {
        position: fixed; right: 20px; top: 128px; max-width: 300px; background: #111827; color: #fff;
        font: 13px/1.4 system-ui, sans-serif; padding: 9px 12px; border-radius: 10px; display: none;
        box-shadow: 0 6px 18px rgba(0,0,0,.25); animation: nj-in .2s ease;
      }
      .toast.show { display: block; }
      .toast.ok { background: #166534; } .toast.err { background: #b91c1c; }
      .panel {
        position: fixed; right: 20px; top: 128px; width: 330px; max-height: 72vh; overflow: auto;
        background: #fff; color: #111827; border-radius: 14px; box-shadow: 0 12px 34px rgba(0,0,0,.28);
        font: 14px/1.45 system-ui, sans-serif; padding: 14px; display: none; animation: nj-in .22s ease;
      }
      .panel.show { display: block; }
      .panel h2 { font-size: 12px; margin: 0 0 10px; color: #374151; font-weight: 600; }
      .field { margin-bottom: 11px; }
      .field label { display: block; font-size: 12px; color: #4b5563; margin-bottom: 4px; }
      .field input, .field textarea { width: 100%; box-sizing: border-box; padding: 7px 9px;
        border: 1px solid #d1d5db; border-radius: 8px; font: 13px system-ui; resize: vertical; }
      .field input:focus, .field textarea:focus { outline: 0; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
      .opts { display: flex; flex-wrap: wrap; gap: 6px; }
      .opt { padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 999px; background: #fff;
        font: 13px system-ui; color: #374151; cursor: pointer; transition: all .15s; }
      .opt:hover { border-color: #2563eb; color: #2563eb; }
      .opt.sel { background: #2563eb; border-color: #2563eb; color: #fff; }
      .row { display: flex; gap: 8px; margin-top: 8px; }
      .btn { flex: 1; padding: 9px; border: 0; border-radius: 9px; cursor: pointer; font: 600 13px system-ui;
        background: #2563eb; color: #fff; }
      .btn.secondary { background: #eef2ff; color: #3730a3; }
      .btn:hover { filter: brightness(1.05); }
      .chatbtn {
        position: fixed; top: 78px; right: 140px; width: 40px; height: 40px; border: 0; border-radius: 50%;
        cursor: pointer; background: #fff; color: #2563eb; font-size: 17px; line-height: 1;
        box-shadow: 0 6px 18px rgba(0,0,0,.18); display: inline-flex; align-items: center; justify-content: center;
        transition: transform .18s, box-shadow .18s;
      }
      .chatbtn:hover { transform: translateY(-1px) scale(1.06); box-shadow: 0 10px 24px rgba(0,0,0,.24); }
      .chat {
        position: fixed; right: 20px; top: 128px; width: 340px; max-height: 74vh; display: none;
        flex-direction: column; background: #fff; color: #111827; border-radius: 14px; overflow: hidden;
        box-shadow: 0 12px 34px rgba(0,0,0,.28); font: 14px/1.45 system-ui, sans-serif; animation: nj-in .22s ease;
      }
      .chat.show { display: flex; }
      .chat-head { padding: 11px 14px; font: 600 13px system-ui; color: #fff;
        background: linear-gradient(135deg, #6366f1, #2563eb); display: flex; justify-content: space-between; align-items: center; }
      .chat-close { cursor: pointer; opacity: .85; }
      .chat-close:hover { opacity: 1; }
      .chat-msgs { overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; min-height: 110px; max-height: 46vh; }
      .chat-empty { color: #9ca3af; font-size: 12px; text-align: center; margin: 14px 4px; }
      .msg { max-width: 88%; padding: 8px 11px; border-radius: 12px; font-size: 13px; white-space: pre-wrap; word-wrap: break-word; }
      .msg.user { align-self: flex-end; background: #2563eb; color: #fff; border-bottom-right-radius: 4px; }
      .msg.ai { align-self: flex-start; background: #f3f4f6; color: #111827; border-bottom-left-radius: 4px; }
      .msg-actions { display: flex; gap: 6px; margin-top: 7px; }
      .msg-actions button { font: 600 11px system-ui; padding: 4px 9px; border-radius: 7px; border: 1px solid #d1d5db;
        background: #fff; color: #374151; cursor: pointer; }
      .msg-actions button:hover { border-color: #2563eb; color: #2563eb; }
      .chat-input { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #eef2ff; }
      .chat-input textarea { flex: 1; box-sizing: border-box; padding: 8px; border: 1px solid #d1d5db; border-radius: 9px;
        font: 13px system-ui; resize: none; }
      .chat-input textarea:focus { outline: 0; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
      .chat-input button { padding: 0 14px; border: 0; border-radius: 9px; background: #2563eb; color: #fff;
        font: 600 13px system-ui; cursor: pointer; }
    </style>
    <button class="fab" id="fab" title="NexJob — fill this form">
      <span class="bolt">⚡</span><span class="ring"></span><span class="txt">Fill form</span>
    </button>
    <button class="chatbtn" id="chatBtn" title="Ask AI to write / edit text">💬</button>
    <div class="toast" id="toast"></div>
    <div class="panel" id="panel">
      <h2>A few fields I couldn't fill — answer once and I'll remember them:</h2>
      <div id="list"></div>
      <div class="row">
        <button class="btn" id="save">Save &amp; fill</button>
        <button class="btn secondary" id="skip">Skip</button>
      </div>
    </div>
    <div class="chat" id="chat">
      <div class="chat-head"><span>💬 Ask AI to write / edit</span><span class="chat-close" id="chatClose">✕</span></div>
      <div class="chat-msgs" id="chatMsgs">
        <div class="chat-empty">Ask me to write or edit text — e.g. "write a 2-line cover note about me", or paste text and say "make this formal". Then Insert it into the field you last clicked.</div>
      </div>
      <div class="chat-input">
        <textarea id="chatText" rows="2" placeholder="Type a request…"></textarea>
        <button id="chatSend">Send</button>
      </div>
    </div>`;

  const $ = (id) => shadow.getElementById(id);
  const fab = $('fab');
  const toastEl = $('toast');
  const panel = $('panel');
  const listEl = $('list');

  let hideTimer = null;
  function toast(text, kind) {
    clearTimeout(hideTimer);
    toastEl.className = 'toast show' + (kind && kind !== 'busy' ? ' ' + kind : '');
    toastEl.textContent = text;
    fab.classList.toggle('busy', kind === 'busy');
    if (kind === 'ok' || kind === 'err') hideTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
  }

  fab.addEventListener('click', runFill);
  $('skip').addEventListener('click', () => panel.classList.remove('show'));
  $('save').addEventListener('click', saveMissing);
  chrome.runtime.onMessage.addListener((m) => { if (m.type === 'runFill') runFill(); });

  // ---- chat: track the last page field the user focused, so "Insert" knows where to write.
  // Focus inside our shadow retargets to `host` at the document level, so we ignore that.
  let lastField = null;
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target;
      if (!t || t === host) return;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) lastField = t;
    },
    true,
  );

  function setFieldValue(el, text) {
    el.focus();
    if (el.isContentEditable) {
      // Select all existing content, then let the editor insert — this turns \n into the
      // editor's own line breaks (<br>/<div>) and fires its framework handlers.
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      if (!document.execCommand('insertText', false, text)) {
        // Fallback if execCommand is unavailable: build <br>-separated lines safely.
        el.textContent = '';
        text.split('\n').forEach((line, i) => {
          if (i) el.appendChild(document.createElement('br'));
          el.appendChild(document.createTextNode(line));
        });
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    toast('Copied.', 'ok');
  }

  const chatEl = $('chat');
  const chatMsgs = $('chatMsgs');
  const chatText = $('chatText');
  const chatHistory = [];

  $('chatBtn').addEventListener('click', () => {
    bringToTop();
    panel.classList.remove('show');
    chatEl.classList.toggle('show');
    if (chatEl.classList.contains('show')) chatText.focus();
  });
  $('chatClose').addEventListener('click', () => chatEl.classList.remove('show'));
  $('chatSend').addEventListener('click', sendChat);
  chatText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  function addBubble(role, text) {
    const empty = chatMsgs.querySelector('.chat-empty');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    chatMsgs.appendChild(div);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
    return div;
  }

  async function sendChat() {
    const text = chatText.value.trim();
    if (!text) return;
    addBubble('user', text);
    chatHistory.push({ role: 'user', content: text });
    chatText.value = '';
    const bubble = addBubble('ai', '…');
    const res = await send({ type: 'chat', messages: chatHistory });
    if (!res.ok) {
      bubble.textContent = 'Error: ' + res.error;
      return;
    }
    const reply = res.reply || '(no response)';
    chatHistory.push({ role: 'assistant', content: reply });
    bubble.textContent = reply;

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const ins = document.createElement('button');
    ins.textContent = 'Insert';
    ins.addEventListener('click', () => {
      if (!lastField || !lastField.isConnected) {
        return toast('Click a text field on the page first, then Insert.', 'err');
      }
      setFieldValue(lastField, reply);
      toast('Inserted into the field.', 'ok');
    });
    const cp = document.createElement('button');
    cp.textContent = 'Copy';
    cp.addEventListener('click', () => copyText(reply));
    actions.appendChild(ins);
    actions.appendChild(cp);
    bubble.appendChild(actions);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  // ---- flow --------------------------------------------------------------
  async function runFill() {
    bringToTop(); // make sure our UI is above any modal opened after page load
    panel.classList.remove('show');
    const s = await send({ type: 'settings' });
    if (!s.ok) return toast('Extension error — try reloading it.', 'err');
    if (!s.apiKey) return toast('Add your OpenAI key in settings.', 'err');
    if (!s.profile) return toast('Add your profile in settings.', 'err');

    let profileObj;
    try {
      profileObj = JSON.parse(s.profile);
    } catch {
      return toast('Profile JSON is invalid — fix it in settings.', 'err');
    }

    toast('Scanning form…', 'busy');
    const fields = extractFields();
    if (!fields.length) return toast('No fillable fields found here.', 'err');

    toast('Found ' + fields.length + ' fields. Asking AI…', 'busy');
    const res = await send({ type: 'map', profile: profileObj, fields });
    if (!res.ok) return toast('Error: ' + res.error, 'err');
    const mappings = res.mappings || [];

    let filledIds = [];
    if (mappings.length) filledIds = (await fillFields(mappings)) || [];
    const mapped = new Set(filledIds.map(String));

    const failed = mappings.filter((m) => !mapped.has(String(m.af_id)));
    if (failed.length && s.executorEnabled) {
      toast('Working out ' + failed.length + ' tricky field(s)…', 'busy');
      for (const m of failed.slice(0, 8)) {
        const html = getFieldHTML(m.af_id);
        if (!html) continue;
        const f = fields.find((x) => String(x.af_id) === String(m.af_id));
        const pr = await send({ type: 'plan', field: { label: f?.label }, value: String(m.value), html });
        if (pr.ok && pr.actions?.length) {
          const done = await runActions(pr.actions);
          if (done > 0) mapped.add(String(m.af_id));
        }
      }
    }

    const texts = fields.filter((f) => isAskableText(f) && !mapped.has(String(f.af_id)) && !f.currentValue);
    const groups = groupChoices(fields, mapped);

    if (texts.length || groups.length) {
      toast('Filled ' + mapped.size + '. ' + (texts.length + groups.length) + ' need your input:', 'ok');
      showMissing(texts, groups);
    } else {
      toast('Filled ' + mapped.size + ' fields. Review, then submit.', 'ok');
    }
  }

  function isAskableText(f) {
    if (!f.label) return false;
    if (f.question !== undefined) return false; // choice option — handled as a group
    return (
      f.tag === 'textarea' || f.tag === 'select' || f.widget ||
      ['text', 'email', 'tel', 'url', 'number', 'search', ''].includes(f.type)
    );
  }

  function groupChoices(fields, mapped) {
    const byGroup = new Map();
    for (const f of fields) {
      if (f.question === undefined) continue;
      const key = f.choiceGroup || f.question || 'grp-' + f.af_id;
      if (!byGroup.has(key)) byGroup.set(key, { question: f.question || 'Choose an option', options: [] });
      byGroup.get(key).options.push({ af_id: f.af_id, option: f.option || f.label });
    }
    const out = [];
    for (const g of byGroup.values()) {
      if (!g.options.length) continue;
      if (g.options.some((o) => mapped.has(String(o.af_id)))) continue;
      out.push(g);
    }
    return out;
  }

  function showMissing(texts, groups) {
    listEl.textContent = '';
    for (const f of texts) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
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
      const lab = document.createElement('label');
      lab.textContent = g.question;
      wrap.appendChild(lab);
      const opts = document.createElement('div');
      opts.className = 'opts';
      for (const o of g.options) {
        const b = document.createElement('button');
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
    bringToTop();
    panel.classList.add('show');
  }

  async function saveMissing() {
    const fillEntries = [];
    const learnEntries = [];
    listEl.querySelectorAll('input[data-af-id], textarea[data-af-id]').forEach((i) => {
      const v = i.value.trim();
      if (!v) return;
      fillEntries.push({ af_id: i.dataset.afId, value: v });
      learnEntries.push({ label: i.dataset.label, value: v });
    });
    listEl.querySelectorAll('.field.group').forEach((g) => {
      const sel = g.querySelector('.opt.sel');
      if (!sel) return;
      fillEntries.push({ af_id: sel.dataset.afId, value: 'true' });
      const q = g.querySelector('label')?.textContent || '';
      learnEntries.push({ label: q, value: sel.textContent });
    });
    if (!fillEntries.length) {
      panel.classList.remove('show');
      return;
    }
    await fillFields(fillEntries);
    await send({ type: 'remember', entries: learnEntries });
    toast('Filled ' + fillEntries.length + ' more and remembered them for next time.', 'ok');
    panel.classList.remove('show');
  }
})();
