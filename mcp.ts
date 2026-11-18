// mcp.ts — Model Context Protocol over streamable HTTP (plain JSON replies):
// modern `server/discover` (2026-07-28) and legacy `initialize` +
// `notifications/initialized`, `tools/list`, `tools/call`. Six GitHub tools.

import { doSquashMerge } from './rest.ts';
import { type Repo, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${store.viewerLogin}/${repo.name}`,
    owner: { login: store.viewerLogin, id: store.viewerId },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function resolveRepo(store: Store, owner: unknown, name: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  const user = store.resolveOwner(owner);
  if (!user) return null;
  return store.findRepo(name);
}

function textResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResult(`Unknown tool: ${name}`);
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return errorResult(`Missing required argument: ${key}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return errorResult('Invalid repository name.');
      if (store.findRepo(repoName)) return errorResult(`Repository ${repoName} already exists.`);
      const repo = store.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return textResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args.owner, args.repo);
      if (!repo) return errorResult('Repository not found.');
      return textResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args.owner, args.repo);
      if (!repo) return errorResult('Repository not found.');
      const now = store.nowIso();
      const issue = {
        id: 100000 + repo.id * 1000 + repo.issueSeq + 1,
        number: repo.issueSeq + 1,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        user: store.viewerLogin,
        createdAt: now,
        updatedAt: now,
        seq: store.seq++,
        comments: [],
      };
      repo.issueSeq += 1;
      repo.issues.push(issue);
      return textResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
        user: { login: store.viewerLogin },
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
      });
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args.owner, args.repo);
      if (!repo) return errorResult('Repository not found.');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.seq - a.seq);
      return textResult(issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((label) => ({ name: label })),
        user: { login: store.viewerLogin },
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
      })));
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args.owner, args.repo);
      if (!repo) return errorResult('Repository not found.');
      const head = args.head as string;
      const base = args.base as string;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha) return errorResult(`Head branch "${head}" does not exist.`);
      if (!baseSha) return errorResult(`Base branch "${base}" does not exist.`);
      const now = store.nowIso();
      const pull = {
        id: 300000 + repo.id * 1000 + repo.prSeq + 1,
        number: repo.prSeq + 1,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
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
      return textResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: pull.head,
        base: pull.base,
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
      });
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args.owner, args.repo);
      if (!repo) return errorResult('Repository not found.');
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((item) => item.number === number);
      if (!pull) return errorResult(`Pull request #${number} not found.`);
      const result = doSquashMerge(store, repo, pull);
      if (!result.ok) return errorResult(result.reason ?? 'Merge conflict');
      return textResult({ merged: true, sha: result.sha, message: result.message, number: pull.number });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/**
 * Handle a POST /mcp body. `bodyText` is the raw text (for the parse-error
 * path); `parsed` is the JSON value when the text parsed, else undefined.
 * Returns {status, body} where body is a JSON value or '' for no content.
 */
export function handleMcp(
  store: Store,
  bodyText: string,
  parsed: unknown,
): { status: number; body: unknown } {
  if (parsed === undefined) {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the request body is not valid JSON' } } };
  }
  void bodyText;
  if (!isRecord(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object') };
  }
  const request = parsed as JsonRpcRequest;
  const id = request.id ?? null;
  const method = request.method;
  if (typeof method !== 'string') {
    return { status: 400, body: rpcError(id, -32600, 'Invalid Request: method is required') };
  }
  const isNotification = request.id === undefined || request.id === null;
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    const result = {
      resultType: 'discover',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    };
    return { status: 200, body: rpcResult(id, result) };
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PREFERRED_REVISION;
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : PREFERRED_REVISION;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }

  if (method.startsWith('notifications/')) {
    // A notification gets no JSON-RPC response: HTTP 202, empty body.
    void isNotification;
    return { status: 202, body: '' };
  }

  if (method === 'tools/list') {
    // Byte-identical across calls: a fixed literal, serialized the same way.
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const toolName = params.name as string | undefined;
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (typeof toolName !== 'string' || toolName === '') {
      return { status: 200, body: rpcError(id, -32602, 'Invalid params: tool name is required') };
    }
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) {
      return { status: 200, body: rpcError(id, -32601, `Method not found: no tool named ${toolName}`) };
    }
    const result = callTool(store, toolName, args);
    if ((result as Record<string, unknown>).isError === true) {
      // A tool failure is a result with isError, not a JSON-RPC error — except
      // a missing required argument, which may also answer -32602.
      const text = ((result.content as Array<{ text?: string }>)?.[0]?.text ?? '') as string;
      if (text.startsWith('Missing required argument:')) {
        return { status: 200, body: rpcError(id, -32602, `Invalid params: ${text}`) };
      }
      return { status: 200, body: rpcResult(id, result) };
    }
    return { status: 200, body: rpcResult(id, result) };
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
