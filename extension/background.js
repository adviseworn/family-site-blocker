// Blocking is done by the browser itself from the rules in rules/adult.json and the list saved from the
// settings page. This script only opens the settings page: right after the extension is installed, so the
// person can see whether anything still needs switching on, and when the toolbar button is clicked.
// Chrome, Edge and Brave run it as a service worker; Firefox runs it as an event page.
const api = globalThis.browser ?? globalThis.chrome;

api.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') api.runtime.openOptionsPage();
});
api.action.onClicked.addListener(() => api.runtime.openOptionsPage());
