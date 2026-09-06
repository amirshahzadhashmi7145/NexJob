// popup.js — the toolbar icon is now just a shortcut. The real UI is the floating button
// on the page (content.js). Clicking "Fill this form" here tells the page to run the flow.

document.getElementById('fill').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const status = document.getElementById('status');
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'runFill' });
    window.close();
  } catch {
    // No content script here (e.g. chrome:// pages, or the page was open before install).
    status.textContent = "Can't run here — open a normal web page, or reload the page once.";
  }
});

document.getElementById('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
