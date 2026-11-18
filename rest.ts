// rest.ts — GitHub REST v3 surface: repos, branches, commits, contents, refs,
// labels, issues (+comments), pull requests (+files, merge). All responses are
// JSON with X-GitHub-Request-Id set by the app layer.

import {
  parseCommit,
  parseObject,
  parseTree,
  sha1Hex,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface HttpResult {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(status: number, value: unknown, headers?: Record<string, string>): HttpResult {
  return { status, headers, body: value };
}

export function err(status: number, message: string): HttpResult {
  return { status, body: { message } };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function strField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------- shapes

export function repoJson(store: Store, repo: Repo, origin: string): Record<string, unknown> {
  const owner = store.viewerLogin;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: store.viewerId, type: 'User' },
    description: repo.description,
    private: repo.private,
    fork: false,
    html_url: `${origin}/${owner}/${repo.name}`,
    url: `${origin}/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label ? hashLabelId(name) : hashLabelId(name),
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    url: '',
  };
}

function hashLabelId(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hash % 1000000 + 1;
}

export function issueJson(store: Store, repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: store.viewerLogin, id: store.viewerId, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `${origin}/${store.viewerLogin}/${repo.name}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${store.viewerLogin}/${repo.name}/issues/${issue.number}`,
    comments_url: `${origin}/api/v3/repos/${store.viewerLogin}/${repo.name}/issues/${issue.number}/comments`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull, origin: string): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.head.ref,
      sha: pull.head.sha,
      label: `${store.viewerLogin}:${pull.head.ref}`,
      repo: { name: repo.name, full_name: `${store.viewerLogin}/${repo.name}` },
    },
    base: {
      ref: pull.base.ref,
      sha: pull.base.sha,
      label: `${store.viewerLogin}:${pull.base.ref}`,
      repo: { name: repo.name, full_name: `${store.viewerLogin}/${repo.name}` },
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: isMergeable(store, repo, pull),
    user: { login: store.viewerLogin, id: store.viewerId, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `${origin}/${store.viewerLogin}/${repo.name}/pull/${pull.number}`,
    url: `${origin}/api/v3/repos/${store.viewerLogin}/${repo.name}/pulls/${pull.number}`,
  };
}

/** A squash merge is clean exactly when the head tip descends from the base tip. */
export function isMergeable(store: Store, repo: Repo, pull: Pull): boolean {
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (!headTip || !baseTip) return false;
  if (headTip === baseTip) return true;
  const stack = [headTip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === baseTip) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const raw = repo.objects.get(oid);
    if (!raw) continue;
    const { type, body } = parseObject(raw);
    if (type !== 'commit') continue;
    for (const parent of parseCommit(body).parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------- pagination

function paginate<T>(items: T[], query: URLSearchParams, origin: string, path: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `${origin}${path}?${params.toString()}`;
  };
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(page - 1)}>; rel="prev"`);
  return { page: slice, link: links.length ? links.join(', ') : null };
}

// ---------------------------------------------------------------- repo lookup

/** Resolve /repos/{owner}/{name}: latch the viewer, 404 anything foreign or missing. */
export function resolveRepo(store: Store, owner: string, name: string): Repo {
  const user = store.resolveOwner(owner);
  if (!user) throw new HttpError(404, 'Not Found');
  const repo = store.findRepo(name);
  if (!repo) throw new HttpError(404, 'Not Found');
  return repo;
}

// ---------------------------------------------------------------- contents helpers

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function treeOfCommit(repo: Repo, commitOid: string): string {
  const raw = repo.objects.get(commitOid);
  if (!raw) return '';
  const { type, body } = parseObject(raw);
  if (type !== 'commit') return '';
  return parseCommit(body).tree;
}

/** Diff two trees: filename, status, additions, deletions, changes. */
export function diffTrees(store: Store, repo: Repo, baseTree: string, headTree: string): Array<Record<string, unknown>> {
  const baseFiles = baseTree ? store.treeFiles(repo, baseTree) : new Map<string, string>();
  const headFiles = headTree ? store.treeFiles(repo, headTree) : new Map<string, string>();
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: Array<Record<string, unknown>> = [];
  const lineCount = (blobOid: string): number => {
    const raw = repo.objects.get(blobOid);
    if (!raw) return 0;
    const text = parseObject(raw).body.toString('utf8');
    if (text === '') return 0;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.length;
  };
  const lineSet = (blobOid: string): Map<string, number> => {
    const raw = repo.objects.get(blobOid);
    const counts = new Map<string, number>();
    if (!raw) return counts;
    const text = parseObject(raw).body.toString('utf8');
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  for (const path of [...paths].sort()) {
    const baseOid = baseFiles.get(path);
    const headOid = headFiles.get(path);
    if (baseOid === undefined && headOid !== undefined) {
      const additions = lineCount(headOid);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (baseOid !== undefined && headOid === undefined) {
      const deletions = lineCount(baseOid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (baseOid !== undefined && headOid !== undefined && baseOid !== headOid) {
      const oldLines = lineSet(baseOid);
      const newLines = lineSet(headOid);
      let additions = 0;
      let deletions = 0;
      for (const [line, count] of newLines) additions += Math.max(0, count - (oldLines.get(line) ?? 0));
      for (const [line, count] of oldLines) deletions += Math.max(0, count - (newLines.get(line) ?? 0));
      if (additions === 0 && deletions === 0) {
        additions = 1;
        deletions = 1;
      }
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the router

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
): HttpResult {
  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, {
      current_user_url: `${origin}/api/v3/user`,
      rate_limit_url: `${origin}/api/v3/rate_limit`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      user_url: `${origin}/api/v3/users/{user}`,
    }, { 'X-Oauth-Scopes': 'repo, read:org' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0' });
  }
  if (segments[0] === 'rate_limit' && segments.length === 1) {
    return json(200, { resources: { core: { limit: 5000, remaining: 4999, reset: 0 } }, rate: { limit: 5000, remaining: 4999, reset: 0 } });
  }
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const viewer = store.viewer();
      return json(200, {
        login: viewer.login,
        id: viewer.id,
        node_id: `U_${viewer.id}`,
        name: viewer.name,
        email: viewer.email,
        type: 'User',
        html_url: `${origin}/${viewer.login}`,
        url: `${origin}/api/v3/user`,
      });
    }
    if (segments[1] === 'repos' && segments.length === 2) {
      if (method === 'POST') {
        const name = strField(body, 'name');
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'Validation Failed: name is invalid');
        if (store.findRepo(name)) return err(422, 'Validation Failed: Repository already exists');
        const repo = store.createRepo(name, strField(body, 'description') ?? '', body !== null && isRecord(body) && body.private === true);
        return json(201, repoJson(store, repo, origin));
      }
      if (method === 'GET') {
        const repos = [...store.repos.values()].sort((a, b) => a.id - b.id);
        const { page, link } = paginate(repos, query, origin, '/api/v3/user/repos');
        const headers: Record<string, string> = {};
        if (link) headers.Link = link;
        return json(200, page.map((repo) => repoJson(store, repo, origin)), headers);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  if (segments[0] !== 'repos') return err(404, 'Not Found');

  // /repos/{owner}/{name}[/...]
  if (segments.length < 3) return err(404, 'Not Found');
  const [owner, name] = [segments[1], segments[2]];
  const repo = resolveRepo(store, owner, name);
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(store, repo, origin));
    if (method === 'PATCH') {
      if (isRecord(body)) {
        const description = strField(body, 'description');
        if (description !== undefined) repo.description = description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        const newName = strField(body, 'name');
        if (newName && newName !== repo.name) {
          if (!/^[A-Za-z0-9._-]+$/.test(newName)) return err(422, 'Validation Failed: name is invalid');
          if (store.findRepo(newName)) return err(422, 'Validation Failed: Repository already exists');
          store.repos.delete(repo.name);
          repo.name = newName;
          store.repos.set(newName, repo);
        }
        repo.updatedAt = store.nowIso();
      }
      return json(200, repoJson(store, repo, origin));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.name);
      return { status: 204, body: '' };
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! }, protected: false }));
      return json(200, branches);
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1]);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return err(404, 'Not Found');
      return json(200, { name: branch, commit: { sha }, protected: false });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'commits') {
    if (method !== 'GET') return err(404, 'Not Found');
    const branch = query.get('sha') ?? repo.defaultBranch;
    const tip = branchTip(repo, branch);
    if (!tip) return json(200, []);
    const chain = store.commitChain(repo, tip);
    const { page, link } = paginate(chain, query, origin, `/api/v3/repos/${owner}/${name}/commits`);
    const headers: Record<string, string> = {};
    if (link) headers.Link = link;
    return json(200, page.map((commit) => ({
      sha: commit.oid,
      commit: { message: commit.message, author: { name: store.viewerLogin, email: store.viewerEmail }, committer: { name: store.viewerLogin, email: store.viewerEmail } },
      author: { login: store.viewerLogin },
    })), headers);
  }

  if (rest[0] === 'contents') {
    return handleContents(store, repo, method, rest.slice(1), query, body, origin);
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = strField(body, 'ref');
      const sha = strField(body, 'sha');
      if (!ref || !ref.startsWith('refs/') || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
        return err(422, 'Validation Failed: ref and sha are required');
      }
      if (repo.refs.has(ref)) return err(422, 'Validation Failed: Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Validation Failed: Object does not exist');
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: 'commit' }, url: `${origin}/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).map((part) => decodeURIComponent(part)).join('/');
      const sha = repo.refs.get(ref);
      if (!sha) return err(404, 'Not Found');
      return json(200, { ref, object: { sha, type: 'commit' } });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })));
    }
    if (method === 'POST' && rest.length === 1) {
      const labelName = strField(body, 'name');
      if (!labelName) return err(422, 'Validation Failed: name is required');
      if (repo.labels.has(labelName)) return err(422, 'Validation Failed: Label already exists');
      const color = strField(body, 'color') ?? 'ededed';
      const description = strField(body, 'description') ?? '';
      repo.labels.set(labelName, { name: labelName, color, description });
      return json(201, { name: labelName, color, description });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'issues') {
    return handleIssues(store, repo, method, rest.slice(1), query, body, origin);
  }

  if (rest[0] === 'pulls') {
    return handlePulls(store, repo, method, rest.slice(1), query, body, origin);
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function handleContents(
  store: Store,
  repo: Repo,
  method: string,
  pathParts: string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
): HttpResult {
  const filePath = pathParts.map((part) => decodeURIComponent(part)).join('/');
  const branch = method === 'GET'
    ? (query.get('ref') ?? repo.defaultBranch)
    : (strField(body, 'branch') ?? repo.defaultBranch);
  const tip = branchTip(repo, branch);
  const files = tip ? store.treeFiles(repo, treeOfCommit(repo, tip)) : new Map<string, string>();

  if (method === 'GET') {
    if (!tip) return err(404, 'Not Found');
    const blobOid = files.get(filePath);
    if (blobOid) {
      const raw = repo.objects.get(blobOid)!;
      const content = parseObject(raw).body;
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: filePath.split('/').pop(),
        path: filePath,
        content: content.toString('base64'),
        sha: blobOid,
      });
    }
    // Directory listing: entries directly under this path.
    const prefix = filePath === '' ? '' : `${filePath}/`;
    const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>();
    for (const [path, oid] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const raw = repo.objects.get(oid)!;
        entries.set(rest, { type: 'file', name: rest, path, sha: oid, size: parseObject(raw).body.length });
      } else {
        const dir = rest.slice(0, slash);
        if (!entries.has(dir)) entries.set(dir, { type: 'dir', name: dir, path: `${prefix}${dir}`, sha: '', size: 0 });
      }
    }
    if (entries.size === 0) return err(404, 'Not Found');
    // Directory shas: the tree oid of each subdirectory.
    const treeOid = treeOfCommit(repo, tip);
    const resolveDirSha = (dirPath: string): string => {
      const parts = dirPath.split('/');
      let current = treeOid;
      for (const part of parts) {
        const raw = repo.objects.get(current);
        if (!raw) return '';
        const entry = parseTree(parseObject(raw).body).find((e) => e.name === part && e.mode === '40000');
        if (!entry) return '';
        current = entry.oid;
      }
      return current;
    };
    const list = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((entry) => ({
      ...entry,
      sha: entry.type === 'dir' ? resolveDirSha(entry.path) : entry.sha,
    }));
    return json(200, list);
  }

  if (method === 'PUT') {
    const message = strField(body, 'message') ?? 'Update file';
    const contentB64 = strField(body, 'content');
    if (contentB64 === undefined) return err(422, 'Validation Failed: content is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return err(422, 'Validation Failed: content is not valid base64');
    }
    const existing = files.get(filePath);
    const providedSha = strField(body, 'sha');
    if (existing) {
      if (!providedSha) return err(422, 'Validation Failed: sha is required to update a file');
      if (providedSha !== existing) return err(409, 'Conflict: sha does not match the current file');
    }
    const blobOid = store.putObject(repo, 'blob', content);
    const nextFiles = new Map(files);
    nextFiles.set(filePath, blobOid);
    const treeOid = store.buildTree(repo, nextFiles);
    const parents = tip ? [tip] : [];
    const commitOid = store.makeCommit(repo, treeOid, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = store.nowIso();
    return json(existing ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: filePath.split('/').pop(),
        path: filePath,
        content: content.toString('base64'),
        sha: blobOid,
      },
      commit: { sha: commitOid, message },
    });
  }

  if (method === 'DELETE') {
    const existing = files.get(filePath);
    if (!existing) return err(404, 'Not Found');
    const providedSha = strField(body, 'sha');
    if (providedSha && providedSha !== existing) return err(409, 'Conflict: sha does not match the current file');
    const message = strField(body, 'message') ?? 'Delete file';
    const nextFiles = new Map(files);
    nextFiles.delete(filePath);
    const treeOid = store.buildTree(repo, nextFiles);
    const parents = tip ? [tip] : [];
    const commitOid = store.makeCommit(repo, treeOid, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = store.nowIso();
    return json(200, { commit: { sha: commitOid, message } });
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- issues

function handleIssues(
  store: Store,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
): HttpResult {
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = strField(body, 'title');
      if (!title) return err(422, 'Validation Failed: title is required');
      const labels: string[] = [];
      if (isRecord(body) && Array.isArray(body.labels)) {
        for (const label of body.labels) {
          if (typeof label === 'string') labels.push(label);
          else if (isRecord(label) && typeof label.name === 'string') labels.push(label.name);
        }
      }
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
      }
      const now = store.nowIso();
      const issue: Issue = {
        id: 100000 + repo.id * 1000 + repo.issueSeq + 1,
        number: repo.issueSeq + 1,
        title,
        body: strField(body, 'body') ?? '',
        state: 'open',
        labels,
        user: store.viewerLogin,
        createdAt: now,
        updatedAt: now,
        seq: store.seq++,
        comments: [],
      };
      repo.issueSeq += 1;
      repo.issues.push(issue);
      return json(201, issueJson(store, repo, issue, origin));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      else if (state !== 'all') return err(422, 'Validation Failed: invalid state');
      const direction = query.get('direction') ?? 'desc';
      const sort = query.get('sort') ?? 'created';
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, link } = paginate(issues, query, origin, `/api/v3/repos/${store.viewerLogin}/${repo.name}/issues`);
      const headers: Record<string, string> = {};
      if (link) headers.Link = link;
      return json(200, page.map((issue) => issueJson(store, repo, issue, origin)), headers);
    }
    return err(404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = repo.issues.find((item) => item.number === number);
  if (!issue) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return json(200, issueJson(store, repo, issue, origin));
    if (method === 'PATCH') {
      if (isRecord(body)) {
        const state = strField(body, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = strField(body, 'title');
        if (title !== undefined) issue.title = title;
        const bodyText = strField(body, 'body');
        if (bodyText !== undefined) issue.body = bodyText;
        if (Array.isArray(body.labels)) {
          const labels: string[] = [];
          for (const label of body.labels) {
            if (typeof label === 'string') labels.push(label);
            else if (isRecord(label) && typeof label.name === 'string') labels.push(label.name);
          }
          for (const label of labels) {
            if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
          }
          issue.labels = labels;
        }
        issue.updatedAt = store.nowIso();
      }
      return json(200, issueJson(store, repo, issue, origin));
    }
    return err(404, 'Not Found');
  }

  if (rest[1] === 'comments') {
    if (method === 'GET') {
      return json(200, issue.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: store.viewerLogin, id: store.viewerId },
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
      })));
    }
    if (method === 'POST') {
      const commentBody = strField(body, 'body');
      if (!commentBody) return err(422, 'Validation Failed: body is required');
      repo.commentSeq += 1;
      const comment = {
        id: 200000 + repo.id * 1000 + repo.commentSeq,
        body: commentBody,
        user: store.viewerLogin,
        createdAt: store.nowIso(),
      };
      issue.comments.push(comment);
      return json(201, {
        id: comment.id,
        body: comment.body,
        user: { login: store.viewerLogin, id: store.viewerId },
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
      });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

/** Squash-merge a pull request onto its base branch. Returns the merge result. */
export function doSquashMerge(
  store: Store,
  repo: Repo,
  pull: Pull,
): { ok: boolean; sha?: string; message?: string; reason?: string } {
  if (pull.state === 'closed') return { ok: false, reason: 'Pull request is already closed' };
  if (!isMergeable(store, repo, pull)) {
    return { ok: false, reason: 'Merge conflict: the head branch is not up to date with the base branch' };
  }
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`)!;
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`)!;
  const headTree = treeOfCommit(repo, headTip);
  const message = `Merge pull request #${pull.number} from ${store.viewerLogin}/${pull.head.ref}`;
  const mergeCommit = store.makeCommit(repo, headTree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.base.ref}`, mergeCommit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.nowIso();
  pull.mergeCommitSha = mergeCommit;
  pull.updatedAt = store.nowIso();
  repo.updatedAt = store.nowIso();
  return { ok: true, sha: mergeCommit, message };
}

function handlePulls(
  store: Store,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
): HttpResult {
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = strField(body, 'title');
      const head = strField(body, 'head');
      const base = strField(body, 'base');
      if (!title || !head || !base) return err(422, 'Validation Failed: title, head and base are required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha) return err(422, `Validation Failed: head branch "${head}" does not exist`);
      if (!baseSha) return err(422, `Validation Failed: base branch "${base}" does not exist`);
      const now = store.nowIso();
      const pull: Pull = {
        id: 300000 + repo.id * 1000 + repo.prSeq + 1,
        number: repo.prSeq + 1,
        title,
        body: strField(body, 'body') ?? '',
        state: 'open',
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        user: store.viewerLogin,
        createdAt: now,
        updatedAt: now,
        seq: store.seq++,
        comments: [],
      };
      repo.prSeq += 1;
      repo.pulls.push(pull);
      return json(201, pullJson(store, repo, pull, origin));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      else if (state !== 'all') return err(422, 'Validation Failed: invalid state');
      pulls.sort((a, b) => b.seq - a.seq);
      const { page, link } = paginate(pulls, query, origin, `/api/v3/repos/${store.viewerLogin}/${repo.name}/pulls`);
      const headers: Record<string, string> = {};
      if (link) headers.Link = link;
      return json(200, page.map((pull) => pullJson(store, repo, pull, origin)), headers);
    }
    return err(404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const pull = repo.pulls.find((item) => item.number === number);
  if (!pull) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return json(200, pullJson(store, repo, pull, origin));
    return err(404, 'Not Found');
  }

  if (rest[1] === 'files' && method === 'GET') {
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    // The PR's files are the diff between the base tip at creation and the head tip.
    // Use the stored head sha and the base sha recorded at creation.
    const headTree = headTip ? treeOfCommit(repo, pull.head.sha) : '';
    const baseTree = pull.base.sha ? treeOfCommit(repo, pull.base.sha) : '';
    void baseTip;
    return json(200, diffTrees(store, repo, baseTree, headTree));
  }

  if (rest[1] === 'merge' && method === 'PUT') {
    if (pull.state === 'closed') return err(405, 'Pull request is already closed');
    const mergeMethod = strField(body, 'merge_method') ?? 'merge';
    if (mergeMethod !== 'squash' && mergeMethod !== 'merge' && mergeMethod !== 'rebase') {
      return err(422, 'Validation Failed: invalid merge_method');
    }
    const result = doSquashMerge(store, repo, pull);
    if (!result.ok) return err(405, result.reason ?? 'Merge conflict');
    return json(200, { merged: true, sha: result.sha, message: result.message });
  }

  if (rest[1] === 'comments') {
    if (method === 'GET') {
      return json(200, pull.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: store.viewerLogin, id: store.viewerId },
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
      })));
    }
    if (method === 'POST') {
      const commentBody = strField(body, 'body');
      if (!commentBody) return err(422, 'Validation Failed: body is required');
      repo.commentSeq += 1;
      const comment = {
        id: 200000 + repo.id * 1000 + repo.commentSeq,
        body: commentBody,
        user: store.viewerLogin,
        createdAt: store.nowIso(),
      };
      pull.comments.push(comment);
      return json(201, {
        id: comment.id,
        body: comment.body,
        user: { login: store.viewerLogin, id: store.viewerId },
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
      });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
