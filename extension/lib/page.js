// Small helpers the record pages share (attempts.html, tries.html, pictures.html, unlisted.html).

/** An element with text and attributes. */
export function element(tag, text, attributes = {}) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const tries = (n) => (n === 1 ? '1 try' : `${n} tries`);

export const whenFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' });
export const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/** Shows the installed version next to the page's title. */
export function showVersion(api) {
  document.getElementById('version').textContent = `Version ${api.runtime.getManifest().version}`;
}
