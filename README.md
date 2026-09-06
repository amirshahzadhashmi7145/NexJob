<img src="icons/icon128.png" width="76" align="right" alt="NexJob logo" />

# NexJob

A load-it-yourself Chrome extension that reads any web form and fills it from your saved
profile. An LLM handles the messy part — matching each field to the right piece of your
data — so it works on sites it has never seen. Your profile and API key stay in your
browser; nothing is sent anywhere except the model you configure.

> Bring your own **OpenAI API key**. Runs unpacked (not on the Chrome Web Store).

---

## Why an LLM?

Autofill on arbitrary sites is really one hard problem: **every site labels its fields
differently** ("Email", "e-mail", `name="applicant_email_2"`). A hardcoded map breaks
constantly. So the only job the model does is **semantic field matching** — given a
field's label / name / placeholder, decide which piece of your profile belongs there.
Plain code does the DOM scan and the actual typing.

---

## Install

1. Clone or download this repo.
2. Go to `chrome://extensions`, toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. The **NexJob** icon appears in your toolbar. (Keep the folder around — deleting
   it removes the extension.)

## Setup

1. Right-click the icon → **Options** (or click the icon → *Edit profile / API key*).
2. Paste your **OpenAI API key** (`sk-...`).
3. Fill in your **Profile JSON**. Click **Load example** to start from a template
   (`profile.example.json`), then edit it with your real details.
4. **Save.**

## Use

1. Open any page with a form (job application, contact form, etc.).
2. Click the floating **⚡ button** at the bottom-right of the page. (No need to open the
   toolbar popup — though the popup's "Fill this form" does the same thing.)
3. Anything it couldn't fill appears in an on-page **"needs your input"** panel — type the
   answers or tap the Yes/No options, click **Save & fill**, and they're filled *and
   remembered* (see below).
4. Review the highlighted fields, fix anything the model guessed wrong, and **submit
   yourself**. The extension never submits for you.

> After installing or updating, **reload any page** you already had open so the floating
> button appears on it.

## Learns as you go

When a field can't be filled from your profile, the extension asks you for it once. Your
answer is **saved back into your profile** (under a `learned` key), so the next form with
that question fills automatically. Over time it needs to ask less and less.

> This is **memory, not model training** — nothing is fine-tuned. Your answers are simply
> stored in `chrome.storage.local` and reused. Screening/essay answers are only ever
> filled from *your own* saved text, never AI-composed — so tools that ban AI writing stay
> honest.

---

## Your data & security

- Your **API key** and **profile** live only in `chrome.storage.local` — in your browser,
  on your machine. They are **never** part of this repository.
- The only network call is to `api.openai.com`, and only when you click *Fill this form*.
  That request contains your profile plus the current page's field labels.
- This is a **public repo with no secrets in it** by design. `profile.example.json` holds
  fake placeholder data only; `.gitignore` blocks real data files.
- Keep it personal — your own key, your own resume. Don't route employer data or a
  company API key through it.

---

## The profile is open-ended

There is **no fixed schema**. Add any keys you want — work authorization, salary
expectations, addresses, references, saved answers to custom questions, social links —
and the model matches form fields against whatever is present. Extending your data is
just editing JSON; no code changes.

---

## How it works

```
Popup ── click "Fill this form"
  │
  ├─ chrome.scripting.executeScript(extractFields)   → scan the page, return field list
  │        (inject.js, runs in the page)
  │
  ├─ fetch api.openai.com  (gpt-4o-mini, JSON-schema structured output)
  │        profile + fields → [{ af_id, value }]      (popup.js, key stays in the popup)
  │
  └─ chrome.scripting.executeScript(fillFields, map) → write values + fire input/change
           (inject.js, runs in the page)
```

| File | Role |
|------|------|
| `manifest.json` | MV3 config — content script (all pages) + background worker + options page |
| `content.js` | Injects the floating ⚡ button + in-page panel; runs the fill flow (DOM access) |
| `inject.js` | `extractFields` / `fillFields` / `getFieldHTML` / `runActions` — the DOM helpers |
| `background.js` | Service worker — the OpenAI calls + storage (keeps the API key out of the page) |
| `popup.html` / `popup.js` | Toolbar shortcut that tells the page to run the flow |
| `options.html` / `options.js` | Full-tab editor for the API key, profile JSON, and the executor toggle |
| `profile.example.json` | Fake starter profile (safe to commit) |
| `test-form.html` | A sample form + a self-check for `extractFields` |

The API key lives in `chrome.storage.local` and is used only by the background worker's
`fetch` — it never enters the web page or the content script.

---

## Test

Open `test-form.html` in Chrome. It runs a self-check on `extractFields` (field count +
label resolution) and shows pass/fail on the page. You can also use it as a scratch form:
click the icon → *Fill this form*.

---

## Handling fields it has no built-in handler for

When the model provides a value but NexJob's built-in primitives can't apply it (an unusual
custom widget), it falls back to an **LLM action planner**: it sends that one field's HTML +
the desired value to the model, which returns an ordered list of **safe actions** from a
fixed set — `click`, `setValue`, `selectOption` — and a small executor runs *only* those.
The model never returns or runs code (Chrome MV3 forbids that, and it would be unsafe); it
only composes whitelisted actions. This is the "agent + safe tools" pattern.

## Roadmap

- **v1 (now):** structured field→value map + safe action-planner fallback for tricky widgets.
- **next:** a full observe→act→retry loop (feed action failures back to the planner), and
  choice questions rendered in the ask panel (done) with learned answers reused over time.

---

## License

MIT — see [LICENSE](LICENSE).
