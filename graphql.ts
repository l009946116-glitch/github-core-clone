// graphql.ts — a focused GraphQL executor for the GitHub-flavoured surface the
// suite uses: viewer/repository/node, issues/pullRequests connections, the five
// mutations, __type introspection, batched operations and cursor pagination.
// It is a real parser + resolver, not a document matcher, so any of the suite's
// documents (and reasonable variations) execute.

import {
  diffTrees,
  doSquashMerge,
  isMergeable,
} from './rest.ts';
import {
  parseCommit,
  parseObject,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- global ids

/** Opaque, stable Relay-style global ids: base64url("<Type>:<key>"). */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { type: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, commentId: number): string {
  return globalId('IssueComment', `${repo.id}:${commentId}`);
}

// ---------------------------------------------------------------- schema (for validation + introspection)

const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt',
  ],
  Ref: ['id', 'name', 'target'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'files', 'repository',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  PullRequestFile: ['id', 'path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'variable'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const next = input[i + 1];
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else value += next;
          i += 2;
        } else {
          value += input[i++];
        }
      }
      i++;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      tokens.push({ kind: 'variable', value: input.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j++;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '.' && input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!@=&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: Selection[] | null;
}

export interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string;
  selections: Selection[];
}

export type Selection = FieldSelection | FragmentSelection;

export interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Record<string, { type: string; defaultValue?: unknown }>;
  selections: Selection[];
}

export interface ParsedDocument {
  operations: Operation[];
  fragments: Record<string, { typeCondition: string; selections: Selection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos++;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): ParsedDocument {
    const operations: Operation[] = [];
    const fragments: ParsedDocument['fragments'] = {};
    while (this.peek() !== null) {
      const token = this.peek()!;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments[name] = { typeCondition, selections };
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let type: Operation['type'] = 'query';
    let name: string | null = null;
    const token = this.peek()!;
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      type = token.value as Operation['type'];
      this.next();
      const next = this.peek();
      if (next && next.kind === 'name') name = this.next().value;
    }
    const variableDefinitions: Operation['variableDefinitions'] = {};
    const maybeParen = this.peek();
    if (maybeParen && maybeParen.kind === 'punct' && maybeParen.value === '(') {
      this.next();
      while (true) {
        const next = this.peek();
        if (!next) throw new Error('unterminated variable definitions');
        if (next.kind === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        const varToken = this.next();
        if (varToken.kind !== 'variable') throw new Error('expected a variable in variable definitions');
        this.expectPunct(':');
        const typeName = this.parseTypeName();
        let defaultValue: unknown;
        const maybeEq = this.peek();
        if (maybeEq && maybeEq.kind === 'punct' && maybeEq.value === '=') {
          this.next();
          defaultValue = this.parseValueLiteral();
        }
        variableDefinitions[varToken.value] = { type: typeName, defaultValue };
      }
    }
    const selections = this.parseSelectionSet();
    return { type, name, variableDefinitions, selections };
  }

  private parseTypeName(): string {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      const inner = this.parseTypeName();
      this.expectPunct(']');
      let suffix = `[${inner}]`;
      const bang = this.peek();
      if (bang && bang.kind === 'punct' && bang.value === '!') {
        this.next();
        suffix += '!';
      }
      return suffix;
    }
    if (token.kind !== 'name') throw new Error('expected a type name');
    let name = token.value;
    const bang = this.peek();
    if (bang && bang.kind === 'punct' && bang.value === '!') {
      this.next();
      name += '!';
    }
    return name;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (true) {
      const token = this.peek();
      if (!token) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): Selection {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek()!;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        // Named fragment spread: recorded as a fragment with the spread's name.
        const spreadName = this.next().value;
        return { kind: 'fragment', typeCondition: `...${spreadName}`, selections: [] };
      }
      throw new Error('malformed fragment spread');
    }
    let alias: string | null = null;
    let name = this.expectName();
    const maybeColon = this.peek();
    if (maybeColon && maybeColon.kind === 'punct' && maybeColon.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, unknown> = {};
    const maybeParen = this.peek();
    if (maybeParen && maybeParen.kind === 'punct' && maybeParen.value === '(') {
      this.next();
      while (true) {
        const next = this.peek();
        if (!next) throw new Error('unterminated arguments');
        if (next.kind === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValueLiteral();
      }
    }
    // Directives (e.g. @include) are parsed and ignored.
    while (true) {
      const next = this.peek();
      if (next && next.kind === 'punct' && next.value === '@') {
        this.next();
        this.expectName();
        const paren = this.peek();
        if (paren && paren.kind === 'punct' && paren.value === '(') {
          this.next();
          let depth = 1;
          while (depth > 0) {
            const t = this.next();
            if (t.kind === 'punct' && t.value === '(') depth++;
            if (t.kind === 'punct' && t.value === ')') depth--;
          }
        }
        continue;
      }
      break;
    }
    let selections: Selection[] | null = null;
    const maybeBrace = this.peek();
    if (maybeBrace && maybeBrace.kind === 'punct' && maybeBrace.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValueLiteral(): unknown {
    const token = this.next();
    if (token.kind === 'variable') return { __variable: token.value };
    if (token.kind === 'string' || token.kind === 'int' || token.kind === 'float') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (true) {
        const next = this.peek();
        if (!next) throw new Error('unterminated list');
        if (next.kind === 'punct' && next.value === ']') {
          this.next();
          return list;
        }
        list.push(this.parseValueLiteral());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (true) {
        const next = this.peek();
        if (!next) throw new Error('unterminated object');
        if (next.kind === 'punct' && next.value === '}') {
          this.next();
          return obj;
        }
        const key = this.expectName();
        this.expectPunct(':');
        obj[key] = this.parseValueLiteral();
      }
    }
    throw new Error(`unexpected value literal ${JSON.stringify(token)}`);
  }
}

export function parseDocument(query: string): ParsedDocument {
  return new Parser(tokenize(query)).parseDocument();
}

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
  fragments: ParsedDocument['fragments'];
  variables: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (isRecord(value) && '__variable' in value) {
    return variables[value.__variable as string];
  }
  if (isRecord(value) && '__enum' in value) return value.__enum as string;
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveValue(item, variables);
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

interface TypedValue {
  type: string;
  value: unknown;
}

function fieldError(ctx: Ctx, type: string, field: string): void {
  ctx.errors.push({ message: `Field '${field}' doesn't exist on type '${type}'` });
}

/** The cursor for an issue number (base64 of "cursor:<number>"). */
function issueCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = decoded.match(/^cursor:(\d+)$/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function executeSelections(ctx: Ctx, parent: TypedValue, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition.startsWith('...')) {
        // Named fragment spread.
        const name = selection.typeCondition.slice(3);
        const fragment = ctx.fragments[name];
        if (fragment) Object.assign(out, executeSelections(ctx, parent, fragment.selections));
        continue;
      }
      if (selection.typeCondition === parent.type || parent.type === 'Node') {
        Object.assign(out, executeSelections(ctx, parent, selection.selections));
      }
      continue;
    }
    const args = resolveArgs(selection.args, ctx.variables);
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(ctx, parent, selection, args);
  }
  return out;
}

function resolveField(ctx: Ctx, parent: TypedValue, field: FieldSelection, args: Record<string, unknown>): unknown {
  const type = parent.type;
  const fields = SCHEMA[type];
  if (fields !== undefined && !fields.includes(field.name) && !field.name.startsWith('__')) {
    fieldError(ctx, type, field.name);
    return null;
  }
  const value = parent.value;
  const sub = (next: TypedValue): unknown =>
    field.selections ? executeSelections(ctx, next, field.selections) : next.value;

  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') {
        const viewer = ctx.store.viewer();
        return sub({ type: 'User', value: viewer });
      }
      if (field.name === 'repository') {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        const user = ctx.store.resolveOwner(owner);
        if (!user) return null;
        const repo = ctx.store.findRepo(name);
        if (!repo) return null;
        return sub({ type: 'Repository', value: repo });
      }
      if (field.name === 'node') {
        const id = args.id as string | undefined;
        if (typeof id !== 'string') return null;
        const parsed = parseGlobalId(id);
        if (!parsed) return null;
        if (parsed.type === 'Repository') {
          const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parsed.key));
          if (!repo) return null;
          return sub({ type: 'Repository', value: repo });
        }
        if (parsed.type === 'Issue') {
          const [repoId, number] = parsed.key.split(':');
          const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(repoId));
          const issue = repo?.issues.find((i) => i.number === Number(number));
          if (!repo || !issue) return null;
          return sub({ type: 'Issue', value: { repo, issue } });
        }
        if (parsed.type === 'PullRequest') {
          const [repoId, number] = parsed.key.split(':');
          const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(repoId));
          const pull = repo?.pulls.find((p) => p.number === Number(number));
          if (!repo || !pull) return null;
          return sub({ type: 'PullRequest', value: { repo, pull } });
        }
        return null;
      }
      if (field.name === '__type') {
        const name = args.name as string | undefined;
        if (typeof name !== 'string') return null;
        return sub({ type: '__Type', value: name });
      }
      if (field.name === '__schema') {
        return sub({ type: '__Schema', value: null });
      }
      return null;
    }
    case 'Mutation': {
      return resolveMutation(ctx, field, args);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = value as { issue: { repo: Repo; issue: Issue }; clientMutationId: unknown };
      if (field.name === 'issue') return sub({ type: 'Issue', value: payload.issue });
      if (field.name === 'clientMutationId') return payload.clientMutationId ?? null;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = value as { pullRequest: { repo: Repo; pull: Pull }; clientMutationId: unknown };
      if (field.name === 'pullRequest') return sub({ type: 'PullRequest', value: payload.pullRequest });
      if (field.name === 'clientMutationId') return payload.clientMutationId ?? null;
      return null;
    }
    case 'AddCommentPayload': {
      const payload = value as {
        commentEdge: { repo: Repo; comment: { id: number; body: string; createdAt: string } };
        subject: { repo: Repo; issue: Issue };
        clientMutationId: unknown;
      };
      if (field.name === 'commentEdge') return sub({ type: 'IssueCommentEdge', value: payload.commentEdge });
      if (field.name === 'subject') return sub({ type: 'Issue', value: payload.subject });
      if (field.name === 'clientMutationId') return payload.clientMutationId ?? null;
      return null;
    }
    case 'IssueCommentConnection': {
      const { repo, issue } = value as { repo: Repo; issue: Issue; args: Record<string, unknown> };
      const comments = issue.comments;
      if (field.name === 'nodes') {
        return comments.map((comment) => sub({ type: 'IssueComment', value: { repo, comment } }));
      }
      if (field.name === 'edges') {
        return comments.map((comment) => sub({ type: 'IssueCommentEdge', value: { repo, comment } }));
      }
      if (field.name === 'pageInfo') {
        return sub({
          type: 'PageInfo',
          value: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        });
      }
      if (field.name === 'totalCount') return comments.length;
      return null;
    }
    case 'User': {
      const user = value as { id: number; login: string; name: string; email: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return globalId('User', String(user.id));
      if (field.name === 'name') return user.name;
      if (field.name === 'email') return user.email;
      return null;
    }
    case 'Repository': {
      const repo = value as Repo;
      if (field.name === 'id') return repoGlobalId(repo);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${ctx.store.viewerLogin}/${repo.name}`;
      if (field.name === 'owner') return sub({ type: 'User', value: ctx.store.viewer() });
      if (field.name === 'defaultBranchRef') return sub({ type: 'Ref', value: { name: repo.defaultBranch, repo } });
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'isPrivate') return repo.private;
      if (field.name === 'createdAt') return repo.createdAt;
      if (field.name === 'updatedAt') return repo.updatedAt;
      if (field.name === 'issue') {
        const number = args.number as number | undefined;
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) return null;
        return sub({ type: 'Issue', value: { repo, issue } });
      }
      if (field.name === 'issues') return sub({ type: 'IssueConnection', value: { repo, args } });
      if (field.name === 'pullRequest') {
        const number = args.number as number | undefined;
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) return null;
        return sub({ type: 'PullRequest', value: { repo, pull } });
      }
      if (field.name === 'pullRequests') return sub({ type: 'PullRequestConnection', value: { repo, args } });
      return null;
    }
    case 'Ref': {
      const ref = value as { name: string; repo: Repo };
      if (field.name === 'name') return ref.name;
      if (field.name === 'id') return globalId('Ref', `${ref.repo.id}:${ref.name}`);
      if (field.name === 'target') {
        const tip = ref.repo.refs.get(`refs/heads/${ref.name}`);
        if (!tip) return null;
        return sub({ type: 'Commit', value: tip });
      }
      return null;
    }
    case 'Issue': {
      const { repo, issue } = value as { repo: Repo; issue: Issue };
      if (field.name === 'id') return issueGlobalId(repo, issue);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'body') return issue.body;
      if (field.name === 'state') return issue.state.toUpperCase();
      if (field.name === 'url') return '';
      if (field.name === 'createdAt') return issue.createdAt;
      if (field.name === 'updatedAt') return issue.updatedAt;
      if (field.name === 'author') return sub({ type: 'User', value: ctx.store.viewer() });
      if (field.name === 'labels') {
        return sub({ type: 'LabelConnection', value: issue.labels.map((name) => ({ name })) });
      }
      if (field.name === 'comments') {
        return sub({ type: 'IssueCommentConnection', value: { repo, issue, args } });
      }
      return null;
    }
    case 'PullRequest': {
      const { repo, pull } = value as { repo: Repo; pull: Pull };
      if (field.name === 'id') return pullGlobalId(repo, pull);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      if (field.name === 'headRefName') return pull.head.ref;
      if (field.name === 'baseRefName') return pull.base.ref;
      if (field.name === 'headRefOid') return pull.head.sha;
      if (field.name === 'baseRefOid') return pull.base.sha;
      if (field.name === 'mergeable') return isMergeable(ctx.store, repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'repository') return sub({ type: 'Repository', value: repo });
      if (field.name === 'files') return sub({ type: 'PullRequestFileConnection', value: { repo, pull, args } });
      return null;
    }
    case 'IssueConnection': {
      const { repo, args: connArgs } = value as { repo: Repo; args: Record<string, unknown> };
      let issues = [...repo.issues];
      const states = connArgs.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = connArgs.orderBy as Record<string, unknown> | undefined;
      const direction = String(orderBy?.direction ?? 'ASC').toUpperCase();
      issues.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
      return issueConnectionResult(ctx, field, repo, issues, connArgs);
    }
    case 'PullRequestConnection': {
      const { repo, args: connArgs } = value as { repo: Repo; args: Record<string, unknown> };
      let pulls = repo.pulls.filter((pull) => pull.state === 'open');
      const states = connArgs.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toUpperCase()));
        pulls = repo.pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      pulls.sort((a, b) => b.seq - a.seq);
      const first = typeof connArgs.first === 'number' ? connArgs.first : undefined;
      const limited = first !== undefined ? pulls.slice(0, first) : pulls;
      if (field.name === 'nodes') {
        return limited.map((pull) => sub({ type: 'PullRequest', value: { repo, pull } }));
      }
      if (field.name === 'edges') {
        return limited.map((pull) => sub({ type: 'PullRequestEdge', value: { repo, pull } }));
      }
      if (field.name === 'pageInfo') {
        return sub({
          type: 'PageInfo',
          value: {
            hasNextPage: first !== undefined && pulls.length > first,
            hasPreviousPage: false,
            startCursor: limited.length ? pullCursor(limited[0].number) : null,
            endCursor: limited.length ? pullCursor(limited[limited.length - 1].number) : null,
          },
        });
      }
      if (field.name === 'totalCount') return pulls.length;
      return null;
    }
    case 'PullRequestFileConnection': {
      const { repo, pull, args: connArgs } = value as { repo: Repo; pull: Pull; args: Record<string, unknown> };
      const headTree = pull.head.sha ? treeOfCommitLocal(repo, pull.head.sha) : '';
      const baseTree = pull.base.sha ? treeOfCommitLocal(repo, pull.base.sha) : '';
      const files = diffTrees(ctx.store, repo, baseTree, headTree);
      const first = typeof connArgs.first === 'number' ? connArgs.first : undefined;
      const limited = first !== undefined ? files.slice(0, first) : files;
      if (field.name === 'nodes') {
        return limited.map((file) => sub({ type: 'PullRequestFile', value: file }));
      }
      if (field.name === 'edges') {
        return limited.map((file) => sub({ type: 'PullRequestFileEdge', value: file }));
      }
      if (field.name === 'pageInfo') {
        return sub({
          type: 'PageInfo',
          value: {
            hasNextPage: first !== undefined && files.length > first,
            hasPreviousPage: false,
            startCursor: null,
            endCursor: null,
          },
        });
      }
      if (field.name === 'totalCount') return files.length;
      return null;
    }
    case 'PullRequestFile': {
      const file = value as Record<string, unknown>;
      if (field.name === 'path') return file.filename;
      if (field.name === 'additions') return file.additions;
      if (field.name === 'deletions') return file.deletions;
      if (field.name === 'changeType') return String(file.status ?? '').toUpperCase();
      if (field.name === 'id') return globalId('PullRequestFile', String(file.filename));
      return null;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestFileEdge': {
      const edgeValue = value as { repo: Repo; issue?: Issue; pull?: Pull } | Record<string, unknown>;
      if (field.name === 'cursor') {
        if ('issue' in edgeValue && edgeValue.issue) return issueCursor(edgeValue.issue.number);
        if ('pull' in edgeValue && edgeValue.pull) return pullCursor(edgeValue.pull.number);
        return null;
      }
      if (field.name === 'node') {
        if ('issue' in edgeValue && edgeValue.issue) {
          return sub({ type: 'Issue', value: { repo: edgeValue.repo, issue: edgeValue.issue } });
        }
        if ('pull' in edgeValue && edgeValue.pull) {
          return sub({ type: 'PullRequest', value: { repo: edgeValue.repo, pull: edgeValue.pull } });
        }
        if ('filename' in edgeValue) return sub({ type: 'PullRequestFile', value: edgeValue });
      }
      return null;
    }
    case 'PageInfo': {
      const info = value as Record<string, unknown>;
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'hasPreviousPage') return info.hasPreviousPage;
      if (field.name === 'startCursor') return info.startCursor ?? null;
      if (field.name === 'endCursor') return info.endCursor ?? null;
      return null;
    }
    case 'IssueComment': {
      const comment = value as { repo: Repo; comment: { id: number; body: string; createdAt: string } };
      if (field.name === 'id') return commentGlobalId(comment.repo, comment.comment.id);
      if (field.name === 'body') return comment.comment.body;
      if (field.name === 'createdAt') return comment.comment.createdAt;
      if (field.name === 'updatedAt') return comment.comment.createdAt;
      if (field.name === 'author') return sub({ type: 'User', value: ctx.store.viewer() });
      return null;
    }
    case 'IssueCommentEdge': {
      const edge = value as { repo: Repo; comment: { id: number; body: string; createdAt: string } };
      if (field.name === 'cursor') return commentGlobalId(edge.repo, edge.comment.id);
      if (field.name === 'node') return sub({ type: 'IssueComment', value: edge });
      return null;
    }
    case 'LabelConnection': {
      const labels = value as Array<{ name: string }>;
      if (field.name === 'nodes') return labels.map((label) => sub({ type: 'Label', value: label }));
      if (field.name === 'totalCount') return labels.length;
      return null;
    }
    case 'Label': {
      const label = value as { name: string };
      if (field.name === 'name') return label.name;
      if (field.name === 'id') return globalId('Label', label.name);
      if (field.name === 'color') return 'ededed';
      if (field.name === 'description') return '';
      return null;
    }
    case '__Type': {
      const name = value as string;
      if (field.name === 'name') return name;
      if (field.name === 'kind') return name in ENUM_VALUES ? 'ENUM' : 'OBJECT';
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const names = SCHEMA[name] ?? [];
        return names.map((fieldName) => sub({ type: '__Field', value: fieldName }));
      }
      if (field.name === 'enumValues') {
        const names = ENUM_VALUES[name] ?? [];
        return names.map((enumName) => sub({ type: '__EnumValue', value: enumName }));
      }
      return null;
    }
    case '__Field': {
      const name = value as string;
      if (field.name === 'name') return name;
      if (field.name === 'description') return null;
      return null;
    }
    case '__EnumValue': {
      const name = value as string;
      if (field.name === 'name') return name;
      if (field.name === 'description') return null;
      return null;
    }
    case '__Schema': {
      if (field.name === 'queryType') return sub({ type: '__Type', value: 'Query' });
      if (field.name === 'mutationType') return sub({ type: '__Type', value: 'Mutation' });
      if (field.name === 'types') {
        return Object.keys(SCHEMA).map((typeName) => sub({ type: '__Type', value: typeName }));
      }
      return null;
    }
    default:
      return null;
  }
}

function pullCursor(number: number): string {
  return Buffer.from(`cursor:pr:${number}`, 'utf8').toString('base64url');
}

function treeOfCommitLocal(repo: Repo, commitOid: string): string {
  const raw = repo.objects.get(commitOid);
  if (!raw) return '';
  const { type, body } = parseObject(raw);
  if (type !== 'commit') return '';
  return parseCommit(body).tree;
}

function issueConnectionResult(
  ctx: Ctx,
  field: FieldSelection,
  repo: Repo,
  issues: Issue[],
  connArgs: Record<string, unknown>,
): unknown {
  const first = typeof connArgs.first === 'number' ? connArgs.first : undefined;
  const after = typeof connArgs.after === 'string' ? cursorNumber(connArgs.after) : null;
  let start = 0;
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    start = index >= 0 ? index + 1 : issues.length;
  }
  const window = issues.slice(start);
  const limited = first !== undefined ? window.slice(0, first) : window;
  if (field.name === 'nodes') {
    return limited.map((issue) => {
      const next: TypedValue = { type: 'Issue', value: { repo, issue } };
      return field.selections ? executeSelections(ctx, next, field.selections) : next.value;
    });
  }
  if (field.name === 'edges') {
    return limited.map((issue) => {
      const next: TypedValue = { type: 'IssueEdge', value: { repo, issue } };
      return field.selections ? executeSelections(ctx, next, field.selections) : next.value;
    });
  }
  if (field.name === 'pageInfo') {
    const hasNextPage = first !== undefined ? window.length > first : false;
    const next: TypedValue = {
      type: 'PageInfo',
      value: {
        hasNextPage,
        hasPreviousPage: start > 0,
        startCursor: limited.length ? issueCursor(limited[0].number) : null,
        endCursor: limited.length ? issueCursor(limited[limited.length - 1].number) : null,
      },
    };
    return field.selections ? executeSelections(ctx, next, field.selections) : next.value;
  }
  if (field.name === 'totalCount') return issues.length;
  return null;
}

// ---------------------------------------------------------------- mutations

function resolveMutation(ctx: Ctx, field: FieldSelection, args: Record<string, unknown>): unknown {
  const input = (isRecord(args.input) ? args.input : {}) as Record<string, unknown>;
  const sub = (type: string, value: unknown): unknown =>
    field.selections ? executeSelections(ctx, { type, value }, field.selections) : value;

  if (field.name === 'createIssue') {
    const repo = findRepoByGlobalId(ctx.store, input.repositoryId as string | undefined);
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return null;
    }
    const title = typeof input.title === 'string' ? input.title : '';
    const now = ctx.store.nowIso();
    const issue: Issue = {
      id: 100000 + repo.id * 1000 + repo.issueSeq + 1,
      number: repo.issueSeq + 1,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      user: ctx.store.viewerLogin,
      createdAt: now,
      updatedAt: now,
      seq: ctx.store.seq++,
      comments: [],
    };
    repo.issueSeq += 1;
    repo.issues.push(issue);
    return sub('CreateIssuePayload', { issue: { repo, issue }, clientMutationId: input.clientMutationId ?? null });
  }
  if (field.name === 'closeIssue') {
    const found = findIssueByGlobalId(ctx.store, input.issueId as string | undefined);
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.updatedAt = ctx.store.nowIso();
    return sub('CloseIssuePayload', { issue: { repo: found.repo, issue: found.issue }, clientMutationId: input.clientMutationId ?? null });
  }
  if (field.name === 'createPullRequest') {
    const repo = findRepoByGlobalId(ctx.store, input.repositoryId as string | undefined);
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return null;
    }
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) {
      ctx.errors.push({ message: 'Head or base ref does not exist.' });
      return null;
    }
    const now = ctx.store.nowIso();
    const pull: Pull = {
      id: 300000 + repo.id * 1000 + repo.prSeq + 1,
      number: repo.prSeq + 1,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user: ctx.store.viewerLogin,
      createdAt: now,
      updatedAt: now,
      seq: ctx.store.seq++,
      comments: [],
    };
    repo.prSeq += 1;
    repo.pulls.push(pull);
    return sub('CreatePullRequestPayload', { pullRequest: { repo, pull }, clientMutationId: input.clientMutationId ?? null });
  }
  if (field.name === 'mergePullRequest') {
    const found = findPullByGlobalId(ctx.store, input.pullRequestId as string | undefined);
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
      return null;
    }
    const result = doSquashMerge(ctx.store, found.repo, found.pull);
    if (!result.ok) {
      ctx.errors.push({ message: result.reason ?? 'Merge conflict' });
      return null;
    }
    return sub('MergePullRequestPayload', { pullRequest: { repo: found.repo, pull: found.pull }, clientMutationId: input.clientMutationId ?? null });
  }
  if (field.name === 'addComment') {
    const found = findIssueByGlobalId(ctx.store, input.subjectId as string | undefined);
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return null;
    }
    const body = typeof input.body === 'string' ? input.body : '';
    found.repo.commentSeq += 1;
    const comment = {
      id: 200000 + found.repo.id * 1000 + found.repo.commentSeq,
      body,
      user: ctx.store.viewerLogin,
      createdAt: ctx.store.nowIso(),
    };
    found.issue.comments.push(comment);
    return sub('AddCommentPayload', {
      commentEdge: { repo: found.repo, comment },
      subject: { repo: found.repo, issue: found.issue },
      clientMutationId: input.clientMutationId ?? null,
    });
  }
  return null;
}

function findRepoByGlobalId(store: Store, id: string | undefined): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Repository') return null;
  return [...store.repos.values()].find((repo) => repo.id === Number(parsed.key)) ?? null;
}

function findIssueByGlobalId(store: Store, id: string | undefined): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':');
  const repo = [...store.repos.values()].find((r) => r.id === Number(repoId));
  const issue = repo?.issues.find((i) => i.number === Number(number));
  if (!repo || !issue) return null;
  return { repo, issue };
}

function findPullByGlobalId(store: Store, id: string | undefined): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':');
  const repo = [...store.repos.values()].find((r) => r.id === Number(repoId));
  const pull = repo?.pulls.find((p) => p.number === Number(number));
  if (!repo || !pull) return null;
  return { repo, pull };
}

// ---------------------------------------------------------------- entry point

/** Execute one GraphQL request body (or an array of them, for operation batching). */
export function executeGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  const run = (item: unknown): Record<string, unknown> => {
    if (!isRecord(item) || typeof item.query !== 'string') {
      return { errors: [{ message: 'A GraphQL operation needs a query string.' }] };
    }
    const variables = isRecord(item.variables) ? (item.variables as Record<string, unknown>) : {};
    let doc: ParsedDocument;
    try {
      doc = parseDocument(item.query);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const operationName = typeof item.operationName === 'string' ? item.operationName : null;
    let operation: Operation | undefined;
    if (operationName) operation = doc.operations.find((op) => op.name === operationName);
    if (!operation) operation = doc.operations[0];
    if (!operation) return { errors: [{ message: 'The document holds no operation.' }] };
    const ctx: Ctx = { store, errors: [], fragments: doc.fragments, variables: { ...variables } };
    for (const [name, def] of Object.entries(operation.variableDefinitions)) {
      if (!(name in ctx.variables) && def.defaultValue !== undefined) {
        ctx.variables[name] = resolveValue(def.defaultValue, {});
      }
    }
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelections(ctx, { type: rootType, value: null }, operation.selections);
    const result: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return result;
  };
  if (Array.isArray(body)) return { status: 200, body: body.map(run) };
  return { status: 200, body: run(body) };
}
