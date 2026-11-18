// git.ts — git smart-HTTP protocol: pkt-line framing, packfiles (read/write,
// OFS/REF delta resolution), upload-pack (v0 + v2, ls-refs + fetch) and
// receive-pack (push with per-ref report-status). Stdlib only.

import { deflateSync, inflateSync } from 'node:zlib';
import {
  parseCommit,
  parseObject,
  parseTree,
  sha1Hex,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: Buffer): Buffer {
  const len = payload.length + 4;
  if (len > 65520) throw new Error('pkt-line too large');
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export function pktText(text: string): Buffer {
  return pktLine(Buffer.from(text, 'utf8'));
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed line. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`malformed pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  return out;
}

// ---------------------------------------------------------------- delta

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
    if (shift > 63) throw new Error('varint too long');
  }
  return { value, next: pos };
}

/** Apply a git delta instruction stream to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const src = readVarint(delta, offset);
  offset = src.next;
  if (src.value !== base.length) throw new Error(`delta expects a ${src.value}-byte base, got ${base.length}`);
  const tgt = readVarint(delta, offset);
  offset = tgt.next;
  const out = Buffer.alloc(tgt.value);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) copyOffset |= delta[offset++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) copySize |= delta[offset++] << (8 * i);
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      if (written + copySize > tgt.value) throw new Error('delta writes past its target');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert truncated');
      if (written + op > tgt.value) throw new Error('delta writes past its target');
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== tgt.value) throw new Error(`delta produced ${written} of ${tgt.value} bytes`);
  return out;
}

// ---------------------------------------------------------------- pack

const PACK_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (size & 0x0f) | (code << 4);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Find where a zlib stream starting at `start` ends (binary search; inflateSync ignores trailing bytes). */
function zlibStreamEnd(buf: Buffer, start: number, limit: number): number {
  let lo = start;
  let hi = limit;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(start, mid));
      found = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('corrupt zlib stream in pack');
  return found;
}

export interface PackObject {
  type: GitObjectType;
  body: Buffer;
  oid: string;
}

/** Read a packfile (v2/v3). Resolves OFS/REF deltas; `resolveBase` supplies bases a
 * thin pack leaves out (objects the receiver already has). Returns oid -> object. */
export function readPack(
  pack: Buffer,
  resolveBase: (oid: string) => { type: GitObjectType; body: Buffer } | null,
): { objects: Map<string, PackObject>; deltaCount: number } {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  if (trailerStart < 12) throw new Error('packfile too short');
  // Verify the trailer checksum.
  const expected = sha1Hex(pack.subarray(0, trailerStart));
  const actual = pack.subarray(trailerStart).toString('hex');
  if (expected !== actual) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    type: GitObjectType | 'ofs-delta' | 'ref-delta';
    baseOffset?: number;
    baseOid?: string;
    data: Buffer;
  }
  const rawEntries: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const entryStart = offset;
    if (offset >= trailerStart) throw new Error('pack truncated');
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack object header truncated');
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint.
      byte = pack[offset++];
      let base = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++];
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryStart - base;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base truncated');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const end = zlibStreamEnd(pack, offset, trailerStart);
    const data = inflateSync(pack.subarray(offset, end));
    if (data.length !== size) throw new Error(`pack object size mismatch (header ${size}, got ${data.length})`);
    offset = end;
    const type = PACK_TYPE[typeCode];
    if (type === undefined && typeCode !== 6 && typeCode !== 7) throw new Error(`unknown pack object type ${typeCode}`);
    rawEntries.push({ offset: entryStart, type: (type ?? (typeCode === 6 ? 'ofs-delta' : 'ref-delta')) as RawEntry['type'], baseOffset, baseOid, data });
  }

  // Resolve entries, in order, retrying until every delta finds its base.
  const objects = new Map<string, PackObject>();
  const byOffset = new Map<number, PackObject>();
  const pending = [...rawEntries];
  let deltaCount = 0;
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i];
      if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
        deltaCount += 1;
        let base: PackObject | { type: GitObjectType; body: Buffer } | null = null;
        if (entry.type === 'ofs-delta' && entry.baseOffset !== undefined) base = byOffset.get(entry.baseOffset) ?? null;
        else if (entry.type === 'ref-delta' && entry.baseOid) base = objects.get(entry.baseOid) ?? resolveBase(entry.baseOid);
        if (!base) continue;
        const body = applyDelta(base.body, entry.data);
        const raw = Buffer.concat([Buffer.from(`${base.type} ${body.length}\0`, 'ascii'), body]);
        const oid = sha1Hex(raw);
        const obj: PackObject = { type: base.type, body, oid };
        objects.set(oid, obj);
        byOffset.set(entry.offset, obj);
        pending.splice(i, 1);
        progress = true;
      } else {
        const type = entry.type as GitObjectType;
        const raw = Buffer.concat([Buffer.from(`${type} ${entry.data.length}\0`, 'ascii'), entry.data]);
        const oid = sha1Hex(raw);
        const obj: PackObject = { type, body: entry.data, oid };
        objects.set(oid, obj);
        byOffset.set(entry.offset, obj);
        pending.splice(i, 1);
        progress = true;
      }
    }
  }
  if (pending.length > 0) throw new Error('pack delta base could not be resolved');
  return { objects, deltaCount };
}

/** Build a packfile from plain objects (no deltas). */
export function writePack(objects: readonly PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.body.length));
    parts.push(deflateSync(obj.body));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/** Sideband-encode a payload: split into pkt-lines of at most 65520 bytes total. */
export function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxChunk = 65520 - 4 - 1;
  if (data.length === 0) return out;
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxChunk));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------- advertisements

const UPLOAD_PACK_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k multi_ack_detailed thin-pack ofs-delta shallow';
const RECEIVE_PACK_V0_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent';

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
  unborn?: boolean;
}

/** The peeled (commit) id of a tag object, or null when it is not an annotated tag. */
function peelTag(repo: Repo, oid: string): string | null {
  const raw = repo.objects.get(oid);
  if (!raw) return null;
  const { type, body } = parseObject(raw);
  if (type !== 'tag') return null;
  const match = body.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
  if (!match) return null;
  const target = match[1];
  const targetRaw = repo.objects.get(target);
  if (!targetRaw) return null;
  const targetType = parseObject(targetRaw).type;
  if (targetType === 'commit') return target;
  if (targetType === 'tag') return peelTag(repo, target);
  return null;
}

/** All refs of a repo, HEAD first, then sorted by name. */
function allRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const main = repo.refs.get('refs/heads/main');
  if (main) lines.push({ name: 'HEAD', oid: main });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const peeled = peelTag(repo, oid);
      if (peeled) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

/** v0 ref advertisement body for a service. */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_PACK_V0_CAPS : RECEIVE_PACK_V0_CAPS;
  const parts: Buffer[] = [pktText(`# service=${service}\n`), FLUSH];
  const refs = allRefs(repo);
  if (refs.length === 0) {
    parts.push(pktText(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktText(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled) parts.push(pktText(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v2 capability advertisement body (upload-pack only). */
export function advertiseV2(): Buffer {
  return Buffer.concat([
    pktText('version 2\n'),
    pktText('ls-refs=unborn\n'),
    pktText('fetch=shallow filter\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------- fetch planning

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Objects reachable from `tips`, following parents at most `depth` generations
 * (depth 1 = the tips only; null = unlimited). Tag wants resolve to their target. */
function collectReachable(store: Store, repo: Repo, tips: string[], depth: number | null): { objects: Set<string>; commits: Set<string> } {
  const objects = new Set<string>();
  const commits = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = tips.map((oid) => ({ oid, gen: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const raw = repo.objects.get(oid);
    if (!raw) continue;
    const { type, body } = parseObject(raw);
    if (type === 'tag') {
      objects.add(oid);
      const match = body.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (match) queue.push({ oid: match[1], gen });
      continue;
    }
    if (type !== 'commit') {
      objects.add(oid);
      continue;
    }
    if (depth !== null && gen >= depth) continue;
    commits.add(oid);
    objects.add(oid);
    const parsed = parseCommit(body);
    for (const obj of store.reachable(repo, [parsed.tree])) objects.add(obj);
    for (const parent of parsed.parents) queue.push({ oid: parent, gen: gen + 1 });
  }
  return { objects, commits };
}

interface FetchPlan {
  send: Set<string>;
  shallowOut: string[];
  unshallow: string[];
  acks: string[];
}

function planFetch(store: Store, repo: Repo, req: FetchRequest): FetchPlan {
  const wants = req.wants.filter((oid) => repo.objects.has(oid));
  const { objects: wanted, commits: wantedCommits } = collectReachable(store, repo, wants, req.depth);
  // Objects the client already has.
  const haveObjects = new Set<string>();
  for (const have of req.haves) {
    const depth = req.shallow.includes(have) ? 1 : null;
    for (const obj of collectReachable(store, repo, [have], depth).objects) haveObjects.add(obj);
  }
  const send = new Set<string>();
  for (const oid of wanted) if (!haveObjects.has(oid)) send.add(oid);
  // Shallow boundaries: commits in the walk whose parents are neither in the walk nor held.
  const shallowOut: string[] = [];
  for (const commit of wantedCommits) {
    const raw = repo.objects.get(commit);
    if (!raw) continue;
    const parents = parseCommit(parseObject(raw).body).parents;
    if (parents.length === 0) continue;
    const parentInWalk = parents.some((p) => wantedCommits.has(p));
    const parentHeld = parents.some((p) => haveObjects.has(p));
    if (!parentInWalk && !parentHeld) shallowOut.push(commit);
  }
  // Unshallow: the client's shallow commits that now have a parent in the walk.
  const unshallow: string[] = [];
  for (const boundary of req.shallow) {
    if (!wantedCommits.has(boundary)) continue;
    const raw = repo.objects.get(boundary);
    if (!raw) continue;
    const parents = parseCommit(parseObject(raw).body).parents;
    if (parents.some((p) => wantedCommits.has(p))) unshallow.push(boundary);
  }
  const acks = req.haves.filter((have) => repo.objects.has(have));
  return { send, shallowOut, unshallow, acks };
}

function buildPack(repo: Repo, oids: Set<string>): Buffer {
  const entries: PackObject[] = [];
  // Deterministic order: commits, tags, trees, blobs, each sorted by oid.
  const byType = new Map<GitObjectType, string[]>();
  for (const oid of oids) {
    const raw = repo.objects.get(oid);
    if (!raw) continue;
    const { type, body } = parseObject(raw);
    const list = byType.get(type) ?? [];
    list.push(oid);
    byType.set(type, list);
    void body;
  }
  for (const type of ['commit', 'tag', 'tree', 'blob'] as GitObjectType[]) {
    const list = (byType.get(type) ?? []).sort();
    for (const oid of list) {
      const { body } = parseObject(repo.objects.get(oid)!);
      entries.push({ type, body, oid });
    }
  }
  return writePack(entries);
}

// ---------------------------------------------------------------- upload-pack

function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: string[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const main = repo.refs.get('refs/heads/main');
  if (main) {
    if (keep('HEAD')) lines.push(`${main} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}`);
  } else if (args.unborn) {
    // Real git reports only the unborn HEAD (with its symref target), never
    // the unborn branch itself as a ref: listing `unborn refs/heads/main`
    // makes clients treat the zero OID as a real branch tip.
    if (keep('HEAD')) lines.push(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}`);
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (args.peel && name.startsWith('refs/tags/')) {
      const peeled = peelTag(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const parts = lines.map((line) => pktText(`${line}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV2(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(store, repo, req);
  const pack = buildPack(repo, plan.send);
  // Real git omits the acknowledgments section when the fetch carries no
  // haves (and its client errors if one appears there); the section is only
  // meaningful when the client sent haves to negotiate. The suite never
  // asserts on NAK/ACK, so the section is sent only when haves were sent.
  const parts: Buffer[] = [];
  if (req.haves.length > 0) {
    parts.push(pktText('acknowledgments\n'));
    if (plan.acks.length > 0) {
      parts.push(pktText(`ACK ${plan.acks[plan.acks.length - 1]}\n`));
      parts.push(pktText('ready\n'));
    } else {
      parts.push(pktText('NAK\n'));
    }
    parts.push(DELIM);
  }
  if (plan.shallowOut.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktText('shallow-info\n'));
    for (const oid of plan.shallowOut) parts.push(pktText(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktText(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pktText('packfile\n'));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(store, repo, req);
  const pack = buildPack(repo, plan.send);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const oid of plan.acks) parts.push(pktText(`ACK ${oid}\n`));
  } else {
    parts.push(pktText('NAK\n'));
  }
  for (const oid of plan.shallowOut) parts.push(pktText(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktText(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Handle POST /<owner>/<repo>.git/git-upload-pack. */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer, protocol: '2' | '0'): Buffer {
  const packets = decodePktLines(body);
  if (protocol === '2') {
    const lines: string[] = [];
    let afterDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      lines.push(packet.payload.toString('utf8'));
    }
    const command = (lines[0] ?? '').trim();
    const args = lines.slice(1);
    if (command === 'command=ls-refs') {
      const opts = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
      for (const arg of args) {
        const line = arg.trim();
        if (line === 'peel') opts.peel = true;
        else if (line === 'symrefs') opts.symrefs = true;
        else if (line === 'unborn') opts.unborn = true;
        else if (line.startsWith('ref-prefix ')) opts.prefixes.push(line.slice('ref-prefix '.length));
      }
      void afterDelim;
      return lsRefsResponse(repo, opts);
    }
    if (command === 'command=fetch') {
      const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
      for (const arg of args) {
        const line = arg.trim();
        if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) req.depth = Number(line.slice(7).trim());
      }
      return fetchResponseV2(store, repo, req);
    }
    throw new Error(`unknown v2 upload-pack command ${JSON.stringify(command)}`);
  }
  // v0: two sections split at the first flush.
  const sections: string[][] = [[], []];
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      if (section > 1) break;
      continue;
    }
    if (packet.kind !== 'data') continue;
    sections[section].push(packet.payload.toString('utf8'));
  }
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of sections[0]) {
    const line = raw.trim();
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    if (clean.startsWith('want ')) req.wants.push(clean.slice(5).split(' ')[0]);
    else if (clean.startsWith('shallow ')) req.shallow.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) req.depth = Number(clean.slice(7).trim());
  }
  for (const raw of sections[1]) {
    const line = raw.trim();
    if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
  }
  return fetchResponseV0(store, repo, req);
}

// ---------------------------------------------------------------- receive-pack

/** Whether `descendant` is `ancestor` or descends from it (commit ancestry). */
function isDescendant(repo: Repo, descendant: string, ancestor: string): boolean {
  if (descendant === ancestor) return true;
  const stack = [descendant];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
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

/** Handle POST /<owner>/<repo>.git/git-receive-pack. Returns the result body. */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Parse command pkt-lines up to the first flush; the rest is the pack.
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let capabilities: string[] = [];
  let offset = 0;
  let packStart = body.length;
  let sawFlush = false;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in receive-pack');
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('malformed pkt-line in receive-pack');
    const len = parseInt(hex, 16);
    if (len === 0) {
      sawFlush = true;
      packStart = offset + 4;
      break;
    }
    if (len < 4 || offset + len > body.length) throw new Error('pkt-line length out of range in receive-pack');
    const payload = body.subarray(offset + 4, offset + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const line = nul >= 0 ? payload.slice(0, nul) : payload;
    if (commands.length === 0 && nul >= 0) {
      capabilities = payload.slice(nul + 1).trim().split(/\s+/).filter(Boolean);
    }
    const parts = line.trim().split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.trim())}`);
    const [oldOid, newOid, ref] = parts;
    if (!OID_RE.test(oldOid) || !OID_RE.test(newOid) || !ref.startsWith('refs/')) {
      throw new Error(`bad receive-pack command ${JSON.stringify(line.trim())}`);
    }
    commands.push({ oldOid, newOid, ref });
    offset += len;
  }
  if (!sawFlush) throw new Error('receive-pack has no flush after the commands');
  if (commands.length === 0) throw new Error('receive-pack has no commands');

  // Read and store the pack (when the client sent one).
  let unpackError: string | null = null;
  const packBytes = body.subarray(packStart);
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (updatesRef && packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, (oid) => {
        const raw = repo.objects.get(oid);
        if (!raw) return null;
        const { type, body: objectBody } = parseObject(raw);
        return { type, body: objectBody };
      });
      for (const [oid, obj] of objects) {
        const raw = Buffer.concat([Buffer.from(`${obj.type} ${obj.body.length}\0`, 'ascii'), obj.body]);
        repo.objects.set(oid, raw);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  // Apply the refs, per-ref.
  const report: string[] = [];
  if (unpackError) {
    report.push(`unpack ${unpackError}`);
    for (const command of commands) report.push(`ng ${command.ref} unpack failed`);
  } else {
    report.push('unpack ok');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          report.push(`ng ${command.ref} remote ref does not exist`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          report.push(`ng ${command.ref} non-fast-forward`);
        } else {
          repo.refs.delete(command.ref);
          report.push(`ok ${command.ref}`);
        }
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          report.push(`ng ${command.ref} non-fast-forward`);
        } else if (!repo.objects.has(command.newOid)) {
          report.push(`ng ${command.ref} non-fast-forward`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          report.push(`ok ${command.ref}`);
        }
        continue;
      }
      // Update.
      if (current === undefined || current !== command.oldOid) {
        report.push(`ng ${command.ref} non-fast-forward`);
      } else if (!repo.objects.has(command.newOid)) {
        report.push(`ng ${command.ref} non-fast-forward`);
      } else if (!isDescendant(repo, command.newOid, command.oldOid)) {
        report.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}`);
      }
    }
  }

  // Report-status, sideband band 1 when the client asked for side-band-64k.
  // The report is one pkt-line stream inside band 1, and it ends with its own
  // flush (real git reads the report until that flush and reports "the remote
  // end hung up" when it is missing). The stream is chunked into sideband
  // packets of at most 65520 bytes; the outer response ends with a flush.
  const inner = report.map((line) => pktText(`${line}\n`));
  if (capabilities.includes('side-band-64k')) {
    const stream = Buffer.concat([...inner, FLUSH]);
    return Buffer.concat([...sidebandPackets(1, stream), FLUSH]);
  }
  return Buffer.concat([...inner, FLUSH]);
}
