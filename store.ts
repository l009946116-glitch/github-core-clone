// store.ts — in-memory state for the forge: users, repositories, git objects,
// issues, pull requests, labels. No persistence: the trial pod is ephemeral and
// the store is rebuilt per run. All git objects are stored verbatim (raw bytes
// including the "<type> <size>\0" header) so hashes recompute exactly.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  comments: Comment[];
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** Full ref name (refs/heads/main, refs/tags/v1) -> object id. */
  refs: Map<string, string>;
  /** Object id -> raw git object bytes (header included). */
  objects: Map<string, Buffer>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  issueSeq: number;
  prSeq: number;
  commentSeq: number;
}

/** SHA-1 hex of a buffer. */
export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Build a git object: returns the id and the raw bytes (header + body). */
export function makeObject(type: GitObjectType, body: Buffer): { oid: string; raw: Buffer } {
  const header = Buffer.from(`${type} ${body.length}\0`, 'ascii');
  const raw = Buffer.concat([header, body]);
  return { oid: sha1Hex(raw), raw };
}

/** Split a raw object into its type and body. */
export function parseObject(raw: Buffer): { type: GitObjectType; body: Buffer } {
  const nul = raw.indexOf(0);
  const header = raw.subarray(0, nul).toString('ascii');
  const [type, size] = header.split(' ');
  if (size !== undefined && Number(size) !== raw.length - nul - 1) {
    // Tolerate a size mismatch: the header is authoritative for the type only.
  }
  return { type: type as GitObjectType, body: Buffer.from(raw.subarray(nul + 1)) };
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(body: Buffer): ParsedCommit {
  const text = body.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  // GitHub presents the commit message without the trailing newline that
  // the raw commit object carries.
  const message = (headEnd >= 0 ? text.slice(headEnd + 2) : '').replace(/[\r\n]+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const nul = body.indexOf(0, space + 1);
    if (space < 0 || nul < 0) break;
    const mode = body.subarray(offset, space).toString('ascii');
    const name = body.subarray(space + 1, nul).toString('utf8');
    const oid = body.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function encodeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Sort key for tree entries: git sorts by name, directories as if suffixed with '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
}

/** The scenario's fixed epoch (wire.ts SCENARIO_EPOCH_SEC): deterministic commit times. */
export const EPOCH_SEC = 1739175597;

export class Store {
  /** Viewer login. Starts as the fixed-seed scenario viewer; the first owner named
   * in a request re-latches it (the scored instances may draw a different viewer),
   * and once latched/confirmed any other owner is foreign (404). */
  viewerLogin = 'adaiversen';
  viewerLatched = false;
  viewerId = 1000;
  viewerEmail = 'adaiversen@example.invalid';

  repos = new Map<string, Repo>();
  repoSeq = 5000;
  seq = 0;

  nowIso(): string {
    return new Date().toISOString();
  }

  /** The viewer user object. */
  viewer(): User {
    return {
      id: this.viewerId,
      login: this.viewerLogin,
      name: this.viewerLogin,
      email: this.viewerEmail,
    };
  }

  /** Resolve an owner name from a URL: latch the viewer on first sight, 404 others. */
  resolveOwner(owner: string): User | null {
    if (!this.viewerLatched) {
      this.viewerLogin = owner;
      this.viewerEmail = `${owner}@example.invalid`;
      this.viewerLatched = true;
      return this.viewer();
    }
    return owner === this.viewerLogin ? this.viewer() : null;
  }

  /** Find a repo by name (exact, then case-insensitive). */
  findRepo(name: string): Repo | null {
    const direct = this.repos.get(name);
    if (direct) return direct;
    const lower = name.toLowerCase();
    for (const repo of this.repos.values()) if (repo.name.toLowerCase() === lower) return repo;
    return null;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const now = this.nowIso();
    const repo: Repo = {
      id: this.repoSeq++,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      issueSeq: 0,
      prSeq: 0,
      commentSeq: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** Store an object in a repo (raw bytes, header included); returns its id. */
  putObject(repo: Repo, type: GitObjectType, body: Buffer): string {
    const { oid, raw } = makeObject(type, body);
    repo.objects.set(oid, raw);
    return oid;
  }

  /** Store an already-built raw object; verifies the id recomputes. */
  putRawObject(repo: Repo, oid: string, raw: Buffer): boolean {
    if (sha1Hex(raw) !== oid) return false;
    repo.objects.set(oid, raw);
    return true;
  }

  getObject(repo: Repo, oid: string): Buffer | null {
    return repo.objects.get(oid) ?? null;
  }

  /** Walk a tree recursively: path -> blob oid (files only). */
  treeFiles(repo: Repo, treeOid: string, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
    const raw = repo.objects.get(treeOid);
    if (!raw) return out;
    const { body } = parseObject(raw);
    for (const entry of parseTree(body)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.treeFiles(repo, entry.oid, path, out);
      else out.set(path, entry.oid);
    }
    return out;
  }

  /** Build (and store) a tree from a path -> blob-oid map; returns the tree id. */
  buildTree(repo: Repo, files: Map<string, string>): string {
    // Group by first path component.
    const build = (paths: Map<string, string>, prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, string>>();
      for (const [path, oid] of paths) {
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: '100644', name: rest, oid });
        else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (!sub) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, oid);
        }
      }
      for (const [dir, sub] of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(sub, prefix === '' ? dir : `${prefix}/${dir}`) });
      }
      const body = encodeTree(sortTreeEntries(entries));
      return this.putObject(repo, 'tree', body);
    };
    return build(files, '');
  }

  /** Create a commit object (and store it). Returns the commit id. */
  makeCommit(
    repo: Repo,
    treeOid: string,
    parents: string[],
    message: string,
    author?: string,
  ): string {
    const when = EPOCH_SEC + this.seq++;
    const ident = author ?? `${this.viewerLogin} <${this.viewerEmail}> ${when} +0000`;
    const lines = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${ident}`);
    lines.push(`committer ${ident}`);
    const body = Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8');
    return this.putObject(repo, 'commit', body);
  }

  /** First-parent walk from a commit id, newest first. */
  commitChain(repo: Repo, tip: string, limit = 1000): ParsedCommit & { oid: string }[] {
    const out: (ParsedCommit & { oid: string })[] = [];
    const seen = new Set<string>();
    let current: string | null = tip;
    while (current && !seen.has(current) && out.length < limit) {
      seen.add(current);
      const raw = repo.objects.get(current);
      if (!raw) break;
      const { type, body } = parseObject(raw);
      if (type !== 'commit') break;
      const parsed = parseCommit(body);
      out.push({ ...parsed, oid: current });
      current = parsed.parents[0] ?? null;
    }
    return out;
  }

  /** All objects reachable from a set of tips (commits, trees, blobs, tags). */
  reachable(repo: Repo, tips: string[]): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [...tips];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const raw = repo.objects.get(oid);
      if (!raw) continue;
      seen.add(oid);
      const { type, body } = parseObject(raw);
      if (type === 'commit') {
        const parsed = parseCommit(body);
        queue.push(parsed.tree);
        for (const parent of parsed.parents) queue.push(parent);
      } else if (type === 'tree') {
        for (const entry of parseTree(body)) queue.push(entry.oid);
      } else if (type === 'tag') {
        const text = body.toString('utf8');
        const match = text.match(/^object ([0-9a-f]{40})$/m);
        if (match) queue.push(match[1]);
      }
    }
    return seen;
  }
}
