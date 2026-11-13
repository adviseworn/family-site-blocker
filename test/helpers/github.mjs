// A stand-in for the part of GitHub's API that the release scripts and the plan use (scripts/release-files.mjs,
// scripts/amo-backup.mjs, scripts/ci-plan.mjs), for one repository: its releases and their files, its tags, and
// what it knows of pull requests, commits and workflow runs. Nothing here contacts GitHub.
import { createServer } from 'node:http';

/**
 * Starts the stand-in. `releases` is [{ tag, draft, files: { name: contents } }]; `tags` are tags without a
 * release; `pulls` maps a commit to the pull requests that brought it in ([{ number, merged, head }]); `trees`
 * maps a commit to its tree; `passed` lists the commits on which the workflow succeeded. The releases are
 * listed `perPage` at a time, whatever is asked, so that a script has to follow the pages.
 * Returns { api, repository, requests, releases(), uploaded, close }.
 */
export async function startGitHub({ repository = 'someone/project', releases = [], tags = [], pulls = {}, trees = {}, passed = [], perPage = 2 } = {}) {
  const requests = [];
  const uploaded = new Map(); // by "tag/name"
  let nextId = 1;
  let base;
  const store = releases.map(({ tag, draft = false, files = {} }) => ({
    id: nextId++,
    tag_name: tag,
    draft,
    name: tag,
    body: '',
    assets: Object.entries(files).map(([name, data]) => ({ id: nextId++, name, data: Buffer.from(data) })),
  }));
  const tagSet = new Set(tags);
  const shown = (release) => ({
    ...release,
    upload_url: `${base}/upload/repos/${repository}/releases/${release.id}/assets{?name,label}`,
    assets: release.assets.map(({ id, name }) => ({ id, name, url: `${base}/repos/${repository}/releases/assets/${id}`, browser_download_url: `${base}/download/${release.tag_name}/${name}` })),
  });
  const body = (request) =>
    new Promise((resolve) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks)));
    });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://x');
    requests.push({ method: request.method, path: url.pathname + url.search, auth: request.headers.authorization, accept: request.headers.accept });
    const json = (value, status = 200) => {
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(value));
    };
    const repo = `/repos/${repository}`;
    const path = url.pathname;
    let match;
    if (request.method === 'GET' && path === `${repo}/releases`) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const pages = Math.max(1, Math.ceil(store.length / perPage));
      if (page < pages) response.setHeader('Link', `<${base}${repo}/releases?per_page=${perPage}&page=${page + 1}>; rel="next", <${base}${repo}/releases?per_page=${perPage}&page=${pages}>; rel="last"`);
      json(store.slice((page - 1) * perPage, page * perPage).map(shown));
    } else if (request.method === 'GET' && (match = new RegExp(`^${repo}/releases/tags/(.+)$`).exec(path))) {
      const release = store.find((entry) => entry.tag_name === decodeURIComponent(match[1]) && !entry.draft);
      if (release) json(shown(release));
      else json({ message: 'Not Found' }, 404);
    } else if (request.method === 'GET' && (match = new RegExp(`^${repo}/git/ref/tags/(.+)$`).exec(path))) {
      const tag = decodeURIComponent(match[1]);
      if (tagSet.has(tag) || store.some((entry) => entry.tag_name === tag && !entry.draft)) json({ ref: `refs/tags/${tag}` });
      else json({ message: 'Not Found' }, 404);
    } else if (request.method === 'POST' && path === `${repo}/releases`) {
      const asked = JSON.parse((await body(request)).toString('utf8'));
      const release = { id: nextId++, draft: false, assets: [], ...asked };
      store.push(release);
      json(shown(release), 201);
    } else if (request.method === 'POST' && (match = new RegExp(`^/upload${repo}/releases/(\\d+)/assets$`).exec(path))) {
      const release = store.find((entry) => entry.id === Number(match[1]));
      const name = url.searchParams.get('name');
      const data = await body(request);
      if (!release) json({ message: 'Not Found' }, 404);
      else if (release.assets.some((asset) => asset.name === name)) json({ message: 'Validation Failed', errors: [{ code: 'already_exists' }] }, 422);
      else {
        const asset = { id: nextId++, name, data };
        release.assets.push(asset);
        uploaded.set(`${release.tag_name}/${name}`, data);
        json({ id: asset.id, name, browser_download_url: `${base}/download/${release.tag_name}/${name}` }, 201);
      }
    } else if (request.method === 'GET' && (match = new RegExp(`^${repo}/releases/assets/(\\d+)$`).exec(path))) {
      // As GitHub does: asked for as a stream of bytes, the file's address answers with where the file is stored.
      const asset = store.flatMap((entry) => entry.assets).find((entry) => entry.id === Number(match[1]));
      if (!asset) json({ message: 'Not Found' }, 404);
      else if (request.headers.accept !== 'application/octet-stream') json({ id: asset.id, name: asset.name });
      else {
        response.statusCode = 302;
        response.setHeader('Location', `/storage/${asset.id}`);
        response.end();
      }
    } else if (request.method === 'GET' && (match = /^\/storage\/(\d+)$/.exec(path))) {
      const asset = store.flatMap((entry) => entry.assets).find((entry) => entry.id === Number(match[1]));
      // The store is another service: it refuses a request that carries GitHub's token.
      if (!asset || request.headers.authorization) json({ message: 'Bad Request' }, 400);
      else response.end(asset.data);
    } else if (request.method === 'GET' && (match = new RegExp(`^${repo}/commits/([0-9a-f]+)/pulls$`).exec(path))) {
      json((pulls[match[1]] ?? []).map(({ number, merged = true, head }) => ({ number, merged_at: merged ? '2026-11-11T20:00:00Z' : null, head: { sha: head } })));
    } else if (request.method === 'GET' && (match = new RegExp(`^${repo}/git/commits/([0-9a-f]+)$`).exec(path))) {
      if (trees[match[1]]) json({ sha: match[1], tree: { sha: trees[match[1]] } });
      else json({ message: 'Not Found' }, 404);
    } else if (request.method === 'GET' && new RegExp(`^${repo}/actions/workflows/[\\w.-]+/runs$`).test(path)) {
      const count = url.searchParams.get('status') === 'success' && passed.includes(url.searchParams.get('head_sha')) ? 1 : 0;
      json({ total_count: count, workflow_runs: [] });
    } else json({ message: 'Not Found' }, 404);
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    api: base,
    repository,
    requests,
    uploaded,
    releases: () => store.map(({ assets, ...release }) => ({ ...release, files: assets.map((asset) => asset.name) })),
    close: () => new Promise((done) => server.close(done)),
  };
}
