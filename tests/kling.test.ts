/**
 * The Kling AI tools, exercised entirely against a mocked fetch.
 *
 * No request here ever leaves the process, and no test submits anything to
 * Kling. What is asserted is the contract that makes these tools safe to hold
 * a real credential: the starting image is always sent as Kling's `image`
 * field, a submission happens at most once per call, paths cannot escape the
 * approved directories, and no credential is ever echoed back.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jwtVerify } from 'jose';
import { KlingClient, type KlingCredential } from '../src/adapters/kling.js';
import { buildKlingTools, PRESERVATION_PREFIX, resolveImage } from '../src/tools/kling.js';
import { ToolRegistry, ToolError } from '../src/tools/registry.js';
import { loadConfig } from '../src/config.js';
import type { KlingConfig } from '../src/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuditLog } from '../src/logging/audit.js';
import { createLogger } from '../src/logging/logger.js';
import { createMcpServer, permittedToolNames } from '../src/server/mcpServer.js';

// A valid 1x1 PNG, so the fixture is a real image and not a text file renamed.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const API_KEY = 'kling-test-api-key-1234567890';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Records every call and answers from a queue of responders. */
function mockFetch() {
  const calls: Recorded[] = [];
  const queue: Array<(req: Recorded) => Response | Promise<Response>> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const rec: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      ...(init?.body ? { body: String(init.body) } : {}),
    };
    calls.push(rec);
    const responder = queue.shift();
    if (!responder) throw new Error(`unexpected fetch: ${rec.method} ${rec.url}`);
    return responder(rec);
  }) as unknown as typeof fetch;
  return { impl, calls, queue };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ok = (data: unknown) => json(200, { code: 0, message: 'SUCCEED', request_id: 'req-1', data });

let inputDir: string;
let outputDir: string;
let fetcher: ReturnType<typeof mockFetch>;
let cfg: KlingConfig;

function makeRegistry(credential: KlingCredential = { kind: 'api_key', apiKey: API_KEY }, overrides: Partial<KlingConfig> = {}) {
  const client = new KlingClient({ baseUrl: 'https://api.test.invalid', credential, fetchImpl: fetcher.impl });
  cfg = {
    apiBase: 'https://api.test.invalid',
    credential,
    inputDir,
    outputDir,
    outputLinkBase: '/opt/carbo-mcp/data/kling/output',
    maxDownloadBytes: 1024 * 1024,
    ...overrides,
  };
  const enabled = new Set(['kling_animate_image', 'kling_video_status', 'kling_download_video']);
  const registry = new ToolRegistry({ elevated: enabled });
  for (const t of buildKlingTools({ client, kling: cfg, enabled })) registry.register(t);
  return registry;
}

function call(registry: ToolRegistry, name: string, input: unknown) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler(tool.inputSchema.parse(input), {
    requestId: 'test',
    subject: 'test-subject',
    signal: new AbortController().signal,
  });
}

async function expectToolError(p: Promise<unknown>, category: string, pattern?: RegExp) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).category).toBe(category);
    if (pattern) expect((err as ToolError).message).toMatch(pattern);
    return err as ToolError;
  }
  throw new Error(`expected ToolError ${category}`);
}

const GOOD_INPUT = { image: 'art.png', prompt: 'move the cup slightly upward and add gentle steam' };

beforeEach(() => {
  inputDir = mkdtempSync(join(tmpdir(), 'kling-in-'));
  outputDir = mkdtempSync(join(tmpdir(), 'kling-out-'));
  writeFileSync(join(inputDir, 'art.png'), PNG_1X1);
  writeFileSync(join(inputDir, 'photo.JPG'), PNG_1X1);
  writeFileSync(join(inputDir, 'notes.txt'), 'not an image');
  mkdirSync(join(inputDir, 'sub'));
  writeFileSync(join(inputDir, 'sub', 'nested.png'), PNG_1X1);
  fetcher = mockFetch();
});

// ---------------------------------------------------------------- registry

describe('registration and risk level', () => {
  it('is refused by a default registry, which stays Level 1 only', () => {
    const client = new KlingClient({ baseUrl: 'https://api.test.invalid', credential: { kind: 'api_key', apiKey: API_KEY }, fetchImpl: fetcher.impl });
    const enabled = new Set(['kling_animate_image']);
    const tools = buildKlingTools({ client, kling: { apiBase: 'https://api.test.invalid', credential: { kind: 'api_key', apiKey: API_KEY }, inputDir, outputDir, outputLinkBase: '', maxDownloadBytes: 1024 }, enabled });
    const registry = new ToolRegistry();
    expect(() => registry.register(tools[0]!)).toThrow(/MCP_ELEVATED_TOOLS/);
  });

  it('registers all three under carbo:kling:generate at risk level 3 when allowlisted', () => {
    const registry = makeRegistry();
    expect(registry.names().sort()).toEqual(['kling_animate_image', 'kling_download_video', 'kling_video_status']);
    for (const n of registry.names()) {
      expect(registry.get(n)!.scope).toBe('carbo:kling:generate');
      expect(registry.get(n)!.risk).toBe(3);
      expect(registry.get(n)!.description).toMatch(/cannot/i);
    }
    expect(registry.get('kling_animate_image')!.description).toMatch(/PAID/);
  });

  it('never advertises a tool that is not in the enabled set', () => {
    const client = new KlingClient({ baseUrl: 'https://api.test.invalid', credential: { kind: 'api_key', apiKey: API_KEY }, fetchImpl: fetcher.impl });
    const enabled = new Set(['kling_video_status']);
    const registry = new ToolRegistry({ elevated: enabled });
    for (const t of buildKlingTools({ client, kling: { apiBase: 'https://api.test.invalid', credential: { kind: 'api_key', apiKey: API_KEY }, inputDir, outputDir, outputLinkBase: '', maxDownloadBytes: 1024 }, enabled })) registry.register(t);
    expect(registry.names()).toEqual(['kling_video_status']);
    expect(registry.get('kling_animate_image')).toBeUndefined();
  });
});

describe('configuration', () => {
  const base = {
    MCP_PUBLIC_ORIGIN: 'https://mcp.example.com',
    OAUTH_ISSUER: 'https://mcp.example.com/realms/carbo',
    OAUTH_JWKS_URI: 'http://carbo-keycloak:8080/realms/carbo/protocol/openid-connect/certs',
  } as NodeJS.ProcessEnv;

  it('leaves Kling unconfigured and the deployment read-only by default', () => {
    const c = loadConfig(base);
    expect(c.kling).toBeUndefined();
    expect(c.elevatedTools).toEqual([]);
  });

  it('refuses to allowlist a kling tool without a credential', () => {
    expect(() => loadConfig({ ...base, MCP_ELEVATED_TOOLS: 'kling_animate_image' })).toThrow(/no Kling credential/);
  });

  it('refuses an unknown elevated tool name', () => {
    expect(() => loadConfig({ ...base, MCP_ELEVATED_TOOLS: 'carbo_run_command' })).toThrow(/Invalid configuration/);
  });

  it('reads the API key from a file and never echoes it in the summary', async () => {
    const keyFile = join(inputDir, 'apikey');
    writeFileSync(keyFile, `${API_KEY}\n`);
    const c = loadConfig({ ...base, KLING_API_KEY_FILE: keyFile, MCP_ELEVATED_TOOLS: 'kling_animate_image,kling_video_status' });
    expect(c.kling?.credential).toEqual({ kind: 'api_key', apiKey: API_KEY });
    expect(c.elevatedTools).toEqual(['kling_animate_image', 'kling_video_status']);
    const { describeConfig } = await import('../src/config.js');
    const summary = JSON.stringify(describeConfig(c));
    expect(summary).not.toContain(API_KEY);
    expect(summary).toContain('"auth":"api_key"');
  });

  it('requires access key and secret key together', () => {
    const f = join(inputDir, 'ak');
    writeFileSync(f, 'AK');
    expect(() => loadConfig({ ...base, KLING_ACCESS_KEY_FILE: f })).toThrow(/together/);
  });
});

// -------------------------------------------------------------- validation

describe('input validation', () => {
  it('refuses path traversal, absolute paths and nested escapes', () => {
    for (const bad of ['../etc/passwd', '/etc/passwd', 'sub/../../x.png', 'C:\\x.png']) {
      expect(() => resolveImage(bad, inputDir)).toThrow(ToolError);
    }
  });

  it('refuses a symlink that points outside the approved directory', () => {
    const outside = join(outputDir, 'outside.png');
    writeFileSync(outside, PNG_1X1);
    symlinkSync(outside, join(inputDir, 'escape.png'));
    expect(() => resolveImage('escape.png', inputDir)).toThrow(/outside the approved/);
  });

  it('refuses non-image files and names the documented formats', () => {
    expect(() => resolveImage('notes.txt', inputDir)).toThrow(/\.jpg, \.jpeg and \.png/);
  });

  it('lists what is available when the file is missing', () => {
    let err: ToolError | undefined;
    try { resolveImage('missing.png', inputDir); } catch (e) { err = e as ToolError; }
    expect(err?.category).toBe('not_found');
    expect(err?.message).toContain('art.png');
    expect(err?.message).not.toContain('notes.txt');
  });

  it('accepts a nested path inside the directory and uppercase extensions', () => {
    expect(resolveImage('sub/nested.png', inputDir).kind).toBe('local');
    expect(resolveImage('photo.JPG', inputDir).kind).toBe('local');
  });

  it('refuses http, data: and credentialed URLs, accepts https', () => {
    expect(() => resolveImage('http://example.com/a.png', inputDir)).toThrow(/https/);
    expect(() => resolveImage('data:image/png;base64,AAAA', inputDir)).toThrow(/Inline base64/);
    expect(() => resolveImage('https://user:pw@example.com/a.png', inputDir)).toThrow(/credentials/);
    const r = resolveImage('https://example.com/pics/a.png', inputDir);
    expect(r).toMatchObject({ kind: 'url', value: 'https://example.com/pics/a.png', name: 'a.png' });
  });

  it('enforces per-model duration, mode and sound support before any request', async () => {
    const registry = makeRegistry();
    await expectToolError(call(registry, 'kling_animate_image', { ...GOOD_INPUT, model: 'kling-v2-6', duration: '7' }), 'invalid_input', /5, 10/);
    await expectToolError(call(registry, 'kling_animate_image', { ...GOOD_INPUT, model: 'kling-v2-6', mode: '4k' }), 'invalid_input', /4k/);
    await expectToolError(call(registry, 'kling_animate_image', { ...GOOD_INPUT, model: 'kling-v2-5-turbo', sound: 'on' }), 'invalid_input', /does not support native audio/);
    await expectToolError(call(registry, 'kling_animate_image', { ...GOOD_INPUT, model: 'kling-v2-6', sound: 'on', mode: 'std' }), 'invalid_input', /1080p/);
    expect(fetcher.calls).toHaveLength(0);
  });

  it('rejects hostile identifiers at the schema', () => {
    const registry = makeRegistry();
    const status = registry.get('kling_video_status')!;
    expect(() => status.inputSchema.parse({ task_id: '../x' })).toThrow();
    const dl = registry.get('kling_download_video')!;
    expect(() => dl.inputSchema.parse({ task_id: 'abc', filename: '../../etc/cron.d/x' })).toThrow();
    expect(() => dl.inputSchema.parse({ task_id: 'abc', filename: '.hidden' })).toThrow();
  });
});

// ---------------------------------------------------------- authentication

describe('authentication', () => {
  it('sends an API key verbatim as a Bearer token', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => ok({ task_id: 't1', task_status: 'submitted', created_at: 1, updated_at: 1 }));
    await call(registry, 'kling_animate_image', GOOD_INPUT);
    expect(fetcher.calls[0]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('signs an HS256 JWT from an access/secret key pair with iss, exp and nbf', async () => {
    const registry = makeRegistry({ kind: 'access_key', accessKey: 'AK123', secretKey: 'SK-secret-value' });
    fetcher.queue.push(() => ok({ task_id: 't1', task_status: 'submitted' }));
    await call(registry, 'kling_animate_image', GOOD_INPUT);
    const auth = fetcher.calls[0]!.headers.Authorization!;
    const token = auth.replace(/^Bearer /, '');
    const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode('SK-secret-value'), { issuer: 'AK123' });
    expect(protectedHeader.alg).toBe('HS256');
    expect(payload.exp! - payload.nbf!).toBe(1805);
    expect(auth).not.toContain('SK-secret-value');
  });

  it('reports a rejected credential without echoing it', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => json(401, { code: 1002, message: 'Authorization is invalid', request_id: 'r-401' }));
    const err = await expectToolError(call(registry, 'kling_animate_image', GOOD_INPUT), 'unavailable', /credential was rejected/);
    expect(err.message).not.toContain(API_KEY);
    expect(err.message).toContain('r-401');
  });
});

// -------------------------------------------------------------- submission

describe('kling_animate_image', () => {
  it('sends the supplied file as Kling\'s starting image, single-shot, with the preservation preset', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => ok({ task_id: 'task-abc', task_status: 'submitted', task_info: { external_task_id: 'x' }, created_at: 1, updated_at: 1 }));
    const out = (await call(registry, 'kling_animate_image', GOOD_INPUT)) as Record<string, any>;

    expect(fetcher.calls).toHaveLength(1);
    const req = fetcher.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.test.invalid/v1/videos/image2video');
    const body = JSON.parse(req.body!);
    expect(body.image).toBe(PNG_1X1.toString('base64'));
    expect(body.image.startsWith('data:')).toBe(false);
    expect(body.model_name).toBe('kling-v2-6');
    expect(body.multi_shot).toBe(false);
    expect(body).not.toHaveProperty('image_tail');
    expect(body).not.toHaveProperty('camera_control');
    expect(body.duration).toBe('5');
    expect(body.mode).toBe('std');
    expect(body.sound).toBe('off');
    expect(body.prompt.startsWith(PRESERVATION_PREFIX)).toBe(true);
    expect(body.prompt).toContain(GOOD_INPUT.prompt);
    expect(body.negative_prompt).toMatch(/camera movement/);
    expect(body.external_task_id).toMatch(/^carbo-mcp-\d{14}-[0-9a-f]{6}$/);

    expect(out.submitted).toBe(true);
    expect(out.paid).toBe(true);
    expect(out.task_id).toBe('task-abc');
    expect(out.status).toBe('submitted');
    expect(out.request.image.sent_as).toMatch(/`image` field/);
    expect(out.request.single_shot).toBe(true);
    expect(out.preservation_note).toMatch(/cannot guarantee/);

    const ledger = readdirSync(join(outputDir, '.jobs'));
    expect(ledger).toEqual(['task-abc.json']);
    const entry = JSON.parse(readFileSync(join(outputDir, '.jobs', 'task-abc.json'), 'utf8'));
    expect(entry.image.name).toBe('art.png');
    expect(JSON.stringify(entry)).not.toContain(API_KEY);
  });

  it('passes an https URL through as the image field and sends the prompt verbatim without the preset', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => ok({ task_id: 't2', task_status: 'submitted' }));
    await call(registry, 'kling_animate_image', {
      image: 'https://cdn.example.com/art.png',
      prompt: 'steam rises',
      preservation_preset: false,
      model: 'kling-v3',
      duration: '8',
      mode: '4k',
      sound: 'on',
    });
    const body = JSON.parse(fetcher.calls[0]!.body!);
    expect(body.image).toBe('https://cdn.example.com/art.png');
    expect(body.prompt).toBe('steam rises');
    expect(body).not.toHaveProperty('negative_prompt');
    expect(body).toMatchObject({ model_name: 'kling-v3', duration: '8', mode: '4k', sound: 'on', multi_shot: false });
  });

  it('dry_run shows the exact job and quota and makes no submission', async () => {
    const registry = makeRegistry();
    fetcher.queue.push((req) => {
      expect(req.url).toMatch(/\/account\/costs\?start_time=\d+&end_time=\d+$/);
      return ok({ resource_pack_subscribe_infos: [{ resource_pack_name: 'Video 200', resource_pack_type: 'decreasing_total', total_quantity: 200, remaining_quantity: 118, status: 'online', invalid_time: 1800000000000 }] });
    });
    const out = (await call(registry, 'kling_animate_image', { ...GOOD_INPUT, dry_run: true })) as Record<string, any>;
    expect(out.submitted).toBe(false);
    expect(out.paid).toBe(false);
    expect(out.request.image.name).toBe('art.png');
    expect(out.request.prompt).toContain(GOOD_INPUT.prompt);
    expect(out.request.model).toBe('kling-v2-6');
    expect(out.request.duration_seconds).toBe(5);
    expect(out.billing.resource_packs[0]).toMatchObject({ name: 'Video 200', remaining: 118 });
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls.every((c) => !c.url.includes('image2video'))).toBe(true);
    expect(existsSync(join(outputDir, '.jobs'))).toBe(false);
  });

  it('dry_run still works when the quota lookup fails', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => json(500, { code: 5000, message: 'boom' }));
    const out = (await call(registry, 'kling_animate_image', { ...GOOD_INPUT, dry_run: true })) as Record<string, any>;
    expect(out.submitted).toBe(false);
    expect(out.billing.note).toMatch(/Quota lookup failed/);
  });

  it('refuses an identical job inside ten minutes unless allow_duplicate is set', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => ok({ task_id: 'first', task_status: 'submitted' }));
    await call(registry, 'kling_animate_image', GOOD_INPUT);
    await expectToolError(call(registry, 'kling_animate_image', GOOD_INPUT), 'invalid_input', /identical job \(task first\)/);
    expect(fetcher.calls).toHaveLength(1);

    fetcher.queue.push(() => ok({ task_id: 'second', task_status: 'submitted' }));
    const out = (await call(registry, 'kling_animate_image', { ...GOOD_INPUT, allow_duplicate: true })) as Record<string, any>;
    expect(out.task_id).toBe('second');
    expect(fetcher.calls).toHaveLength(2);
  });

  it('does not retry an ambiguous network failure and tells the caller how to check', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => { throw new Error('socket hang up'); });
    const err = await expectToolError(call(registry, 'kling_animate_image', GOOD_INPUT), 'upstream', /may or may not have been created/);
    expect(err.message).toMatch(/carbo-mcp-\d{14}-[0-9a-f]{6}/);
    expect(fetcher.calls).toHaveLength(1);
    expect(existsSync(join(outputDir, '.jobs'))).toBe(false);
  });

  it('maps Kling refusals to stable categories', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => json(429, { code: 1303, message: 'parallel task over resource pack limit', request_id: 'r1' }));
    await expectToolError(call(registry, 'kling_animate_image', GOOD_INPUT), 'upstream', /concurrency limit/);
    fetcher.queue.push(() => json(400, { code: 1301, message: 'content blocked', request_id: 'r2' }));
    await expectToolError(call(registry, 'kling_animate_image', { ...GOOD_INPUT, prompt: 'something else entirely' }), 'invalid_input', /content policy/);
    fetcher.queue.push(() => json(400, { code: 1201, message: 'image aspect ratio out of range', request_id: 'r3' }));
    await expectToolError(call(registry, 'kling_animate_image', { ...GOOD_INPUT, prompt: 'a third distinct prompt' }), 'invalid_input', /aspect ratio out of range/);
    fetcher.queue.push(() => json(429, { code: 1102, message: 'resource pack exhausted', request_id: 'r4' }));
    await expectToolError(call(registry, 'kling_animate_image', { ...GOOD_INPUT, prompt: 'a fourth distinct prompt' }), 'unavailable', /exhausted/);
    fetcher.queue.push(() => new Response('<html>gateway</html>', { status: 502 }));
    await expectToolError(call(registry, 'kling_animate_image', { ...GOOD_INPUT, prompt: 'a fifth distinct prompt' }), 'upstream', /non-JSON/);
  });
});

// ----------------------------------------------------------------- polling

describe('kling_video_status', () => {
  it('queries by id and reports an in-progress job as not done', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => ok({ task_id: 'task-1', task_status: 'processing', created_at: 1722769557708, updated_at: 1722769560000 }));
    const out = (await call(registry, 'kling_video_status', { task_id: 'task-1' })) as Record<string, any>;
    expect(fetcher.calls[0]!.url).toBe('https://api.test.invalid/v1/videos/image2video/task-1');
    expect(fetcher.calls[0]!.method).toBe('GET');
    expect(out).toMatchObject({ task_id: 'task-1', status: 'processing', done: false });
    expect(out.video).toBeUndefined();
  });

  it('returns the result URL, duration, cost and what was submitted on success', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => ok({ task_id: 'task-2', task_status: 'submitted' }));
    await call(registry, 'kling_animate_image', GOOD_INPUT);
    fetcher.queue.push(() => ok({
      task_id: 'task-2',
      task_status: 'succeed',
      task_result: { videos: [{ id: 'v1', url: 'https://cdn.test.invalid/v1.mp4', watermark_url: 'https://cdn.test.invalid/v1w.mp4', duration: '5.04' }] },
      final_unit_deduction: '5',
      final_balance_deduction: { quota: '0.35', list_price: '0.49' },
    }));
    const out = (await call(registry, 'kling_video_status', { task_id: 'task-2' })) as Record<string, any>;
    expect(out.done).toBe(true);
    expect(out.video).toMatchObject({ url: 'https://cdn.test.invalid/v1.mp4', duration_seconds: 5.04 });
    expect(out.cost).toEqual({ units_deducted: '5', balance_quota: '0.35', balance_list_price: '0.49' });
    expect(out.submitted).toMatchObject({ model: 'kling-v2-6', image: 'art.png', duration_seconds: 5 });
  });

  it('surfaces the failure reason for a failed job', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => ok({ task_id: 'task-3', task_status: 'failed', task_status_msg: 'Triggered content risk control' }));
    const out = (await call(registry, 'kling_video_status', { task_id: 'task-3' })) as Record<string, any>;
    expect(out).toMatchObject({ status: 'failed', done: true, failure_reason: 'Triggered content risk control' });
  });

  it('reports an unknown task as not_found', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => json(404, { code: 1203, message: 'task not found', request_id: 'r' }));
    await expectToolError(call(registry, 'kling_video_status', { task_id: 'nope' }), 'not_found');
  });
});

// ---------------------------------------------------------------- download

describe('kling_download_video', () => {
  const succeeded = (id: string) => ok({
    task_id: id,
    task_status: 'succeed',
    task_result: { videos: [{ id: 'v', url: `https://cdn.test.invalid/${id}.mp4`, watermark_url: `https://cdn.test.invalid/${id}-wm.mp4`, duration: '5' }] },
  });

  it('downloads into the output directory, returns the link, and is idempotent', async () => {
    const registry = makeRegistry();
    const payload = Buffer.alloc(4096, 7);
    fetcher.queue.push(() => succeeded('task-d'));
    fetcher.queue.push((req) => {
      expect(req.url).toBe('https://cdn.test.invalid/task-d.mp4');
      expect(req.headers.Authorization).toBeUndefined();
      return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
    });
    const out = (await call(registry, 'kling_download_video', { task_id: 'task-d' })) as Record<string, any>;
    expect(out).toMatchObject({ file: 'task-d.mp4', bytes: 4096, downloaded_now: true, link: '/opt/carbo-mcp/data/kling/output/task-d.mp4' });
    expect(readFileSync(join(outputDir, 'task-d.mp4'))).toEqual(payload);
    expect(readdirSync(outputDir).filter((f) => f.endsWith('.part'))).toEqual([]);

    fetcher.queue.push(() => succeeded('task-d'));
    const again = (await call(registry, 'kling_download_video', { task_id: 'task-d' })) as Record<string, any>;
    expect(again.downloaded_now).toBe(false);
    expect(fetcher.calls).toHaveLength(3);
  });

  it('builds a Windows UNC link when the link base uses backslashes', async () => {
    const registry = makeRegistry(undefined, { outputLinkBase: '\\\\10.0.0.39\\CarboFolder\\Videos\\Kling' });
    fetcher.queue.push(() => succeeded('task-u'));
    fetcher.queue.push(() => new Response(Buffer.alloc(10), { status: 200 }));
    const out = (await call(registry, 'kling_download_video', { task_id: 'task-u' })) as Record<string, any>;
    expect(out.link).toBe('\\\\10.0.0.39\\CarboFolder\\Videos\\Kling\\task-u.mp4');
  });

  it('honours a custom filename and the watermarked variant', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => succeeded('task-e'));
    fetcher.queue.push((req) => {
      expect(req.url).toBe('https://cdn.test.invalid/task-e-wm.mp4');
      return new Response(Buffer.alloc(10), { status: 200 });
    });
    const out = (await call(registry, 'kling_download_video', { task_id: 'task-e', filename: 'good-morning', watermarked: true })) as Record<string, any>;
    expect(out.file).toBe('good-morning.mp4');
    expect(existsSync(join(outputDir, 'good-morning.mp4'))).toBe(true);
  });

  it('refuses to download a job that has not succeeded', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => ok({ task_id: 'p', task_status: 'processing' }));
    await expectToolError(call(registry, 'kling_download_video', { task_id: 'p' }), 'unavailable', /still processing/);
    fetcher.queue.push(() => ok({ task_id: 'f', task_status: 'failed', task_status_msg: 'nope' }));
    await expectToolError(call(registry, 'kling_download_video', { task_id: 'f' }), 'upstream', /failed: nope/);
    expect(fetcher.calls).toHaveLength(2);
  });

  it('aborts an oversized download and leaves no partial file', async () => {
    const registry = makeRegistry(undefined, { maxDownloadBytes: 1024 * 1024 });
    fetcher.queue.push(() => succeeded('task-big'));
    fetcher.queue.push(() => new Response(Buffer.alloc(2 * 1024 * 1024), { status: 200 }));
    await expectToolError(call(registry, 'kling_download_video', { task_id: 'task-big' }), 'upstream', /limit/);
    expect(readdirSync(outputDir).filter((f) => f.startsWith('task-big'))).toEqual([]);
  });

  it('refuses a non-https result URL', async () => {
    const registry = makeRegistry();
    fetcher.queue.push(() => ok({ task_id: 'h', task_status: 'succeed', task_result: { videos: [{ url: 'http://cdn.test.invalid/h.mp4' }] } }));
    await expectToolError(call(registry, 'kling_download_video', { task_id: 'h' }), 'upstream', /not https/);
  });
});

// ------------------------------------------------------------ MCP surface

describe('MCP advertisement', () => {
  async function connect(scopes: string[]) {
    const registry = makeRegistry();
    const gatewayCfg = {
      ...loadConfig({
        MCP_PUBLIC_ORIGIN: 'https://mcp.example.com',
        OAUTH_ISSUER: 'https://mcp.example.com/realms/carbo',
        OAUTH_JWKS_URI: 'http://carbo-keycloak:8080/realms/carbo/protocol/openid-connect/certs',
      }),
    };
    const audit = new AuditLog(mkdtempSync(join(tmpdir(), 'kling-audit-')), 1024 * 1024, 2, createLogger('silent'));
    audit.init();
    const auth = { subject: 'sub', scopes: new Set(scopes), clientId: 'test' } as never;
    const server = createMcpServer(gatewayCfg, registry, auth, 'req-1', audit, createLogger('silent'));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'vitest', version: '1.0.0' });
    await client.connect(clientSide);
    return { client, registry, auth };
  }

  it('advertises the kling tools as non-read-only, open-world, and warns that generation is paid', async () => {
    const { client } = await connect(['carbo:kling:generate']);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['kling_animate_image', 'kling_download_video', 'kling_video_status']);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(false);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.annotations?.openWorldHint).toBe(true);
    }
    expect(client.getInstructions()).toMatch(/PAID video-generation job/);
    expect(client.getInstructions()).toMatch(/read-only/i);
  });

  it('hides every kling tool from a token that lacks the generate scope', async () => {
    const { client, registry, auth } = await connect(['carbo:server:read']);
    // With nothing permitted the SDK registers no tools/list handler at all,
    // so the gateway's own filter is what is asserted here.
    expect(permittedToolNames(registry, auth)).toEqual([]);
    expect(client.getInstructions()).not.toMatch(/PAID/);
  });
});
