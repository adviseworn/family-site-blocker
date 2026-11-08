#!/usr/bin/env node
// The guide: README.md rendered as the front page of the project's public GitLab Pages site (GUIDE_URL in
// scripts/updates-site.mjs). The project is private, so the README on GitLab can only be read by its members;
// the settings pages link into this copy instead, by heading, with the anchors GitLab and GitHub give
// headings (anchor), so the links land. The update-files job of .gitlab-ci.yml writes it after each release,
// next to the update files, and puts the Firefox lock's profile beside it, with the add-on's icon (ICON_NAME) for
// the heading and the browser's tab.
//
// usage: node scripts/guide.mjs <README.md> <site folder> [the lock's profile to copy there]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Marked } from 'marked';
import { ICON_NAME, PROFILE_NAME } from './updates-site.mjs';

/** The add-on's own icon, the biggest one it ships. */
export const ICON_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons', 'icon128.png');

/**
 * The anchor GitLab (and GitHub) gives a heading: lower case, everything but letters, numbers, spaces, hyphens
 * and underscores dropped, spaces to hyphens. (GitLab also folds runs of hyphens into one, which no heading
 * here has; test/readme.test.mjs checks that the anchors are distinct.)
 */
export const anchor = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: Canvas; color: CanvasText; }
main { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
h1, h2, h3, h4 { line-height: 1.25; margin: 2em 0 0.6em; }
h1 { font-size: 1.9rem; margin-top: 0.6em; }
h1 img { width: 1.5em; height: 1.5em; vertical-align: -0.3em; margin-right: 0.3em; }
a { color: LinkText; }
:target { scroll-margin-top: 1rem; }
li { margin: 0.2em 0; }
code { font: 0.92em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: rgba(127, 127, 127, 0.15); padding: 0.1em 0.3em; border-radius: 3px; }
pre { overflow: auto; padding: 0.8rem; background: rgba(127, 127, 127, 0.12); border-radius: 6px; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; display: block; overflow: auto; max-width: 100%; }
th, td { border: 1px solid rgba(127, 127, 127, 0.4); padding: 0.3em 0.6em; vertical-align: top; text-align: left; }
blockquote { margin: 0; padding-left: 1em; border-left: 3px solid rgba(127, 127, 127, 0.4); }
`;

/** The page: the README's HTML, each heading with its anchor as its id, on a plain readable page. */
export function renderGuide(markdown) {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth, text }) {
        const icon = depth === 1 ? `<img src="${ICON_NAME}" alt="" width="128" height="128">` : '';
        return `<h${depth} id="${anchor(text)}">${icon}${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });
  const body = marked.parse(markdown);
  const title = /^# (.+)$/m.exec(markdown)?.[1] ?? 'Guide';
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n<link rel="icon" href="${ICON_NAME}" type="image/png" sizes="128x128">\n<style>${STYLE}</style>\n</head>\n<body>\n<main>\n${body}</main>\n</body>\n</html>\n`;
}

/** Writes the guide as index.html in `outDir`, with the add-on's icon as ICON_NAME beside it, and the lock's profile as PROFILE_NAME when given. */
export function buildGuide(readmePath, outDir, profilePath) {
  mkdirSync(outDir, { recursive: true });
  const html = renderGuide(readFileSync(readmePath, 'utf8'));
  writeFileSync(join(outDir, 'index.html'), html);
  copyFileSync(ICON_SOURCE, join(outDir, ICON_NAME));
  if (profilePath) copyFileSync(profilePath, join(outDir, PROFILE_NAME));
  return html;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [readme, outDir, profile] = process.argv.slice(2);
  if (!readme || !outDir) {
    console.error("usage: node scripts/guide.mjs <README.md> <site folder> [the lock's profile]");
    process.exit(2);
  }
  const html = buildGuide(readme, outDir, profile);
  const headings = (html.match(/<h[1-6] id=/g) ?? []).length;
  console.log(`Wrote ${join(outDir, 'index.html')}: ${headings} headings, ${ICON_NAME}${profile ? ` and ${PROFILE_NAME}` : ''}`);
}
