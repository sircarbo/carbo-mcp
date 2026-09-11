/**
 * Kling AI API client.
 *
 * Covers exactly the four documented calls the Kling tools need and nothing
 * more. Facts below were taken from the official reference at
 * https://kling.ai/document-api (fetched 2026-09-11):
 *
 *   base URL        https://api-singapore.klingai.com   (for callers outside China;
 *                   the docs note the endpoint moved here from api.klingai.com)
 *   create task     POST /v1/videos/image2video          body: model_name, image, prompt, ...
 *   query task      GET  /v1/videos/image2video/{id}     id = task_id or external_task_id
 *   resource packs  GET  /account/costs?start_time&end_time   (free; keep QPS <= 1)
 *
 * Authentication, per the "Authentication" page, is one of:
 *   - an API Key sent verbatim as `Authorization: Bearer <key>` ("for all models"), or
 *   - an Access Key / Secret Key pair, from which the caller signs an HS256 JWT
 *     { iss: <access key>, exp: now+1800, nbf: now-5 } and sends that as the
 *     Bearer token. The docs scope this second scheme to the legacy request
 *     design (model_name in the body), which is the design used here, so both
 *     schemes work with these endpoints.
 *
 * The client never logs, returns, or embeds a credential in an error. Every
 * failure is reduced to a status code, Kling's numeric service code, its
 * message text, and its request_id.
 */
import { createWriteStream, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SignJWT } from 'jose';

export type KlingCredential =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'access_key'; accessKey: string; secretKey: string };

export interface KlingClientOptions {
  baseUrl: string;
  credential: KlingCredential;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
}

/** Fields of the create-task request body that this gateway ever sends. */
export interface ImageToVideoRequest {
  model_name: string;
  /** Raw base64 (no data: prefix) or a URL. Always the supplied starting image. */
  image: string;
  prompt: string;
  negative_prompt?: string;
  multi_shot: false;
  duration: string;
  mode: string;
  sound?: 'on' | 'off';
  external_task_id: string;
}

export interface KlingTaskVideo {
  id?: string;
  url?: string;
  watermark_url?: string;
  duration?: string;
}

export interface KlingTask {
  task_id: string;
  task_status: 'submitted' | 'processing' | 'succeed' | 'failed' | string;
  task_status_msg?: string;
  task_info?: { external_task_id?: string };
  task_result?: { videos?: KlingTaskVideo[] };
  final_unit_deduction?: string;
  final_balance_deduction?: { quota?: string; list_price?: string };
  created_at?: number;
  updated_at?: number;
}

export interface KlingResourcePack {
  resource_pack_name?: string;
  resource_pack_type?: string;
  total_quantity?: number;
  remaining_quantity?: number;
  invalid_time?: number;
  status?: string;
}

interface KlingEnvelope<T> {
  code: number;
  message: string;
  request_id?: string;
  data?: T;
}

/** Kling answered, and the answer was a refusal or a failure. */
export class KlingApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly serviceCode: number,
    message: string,
    readonly requestId: string | undefined,
  ) {
    super(message);
    this.name = 'KlingApiError';
  }
}

/**
 * The request may or may not have reached Kling. Callers that submitted a
 * paid job must treat this as "unknown", never as "not submitted".
 */
export class KlingNetworkError extends Error {
  constructor(message: string, readonly phase: 'request' | 'response') {
    super(message);
    this.name = 'KlingNetworkError';
  }
}

const JWT_LIFETIME_SECONDS = 1800;
const JWT_NOT_BEFORE_SKEW_SECONDS = 5;
/** Re-sign well before expiry so a token is never presented in its last minutes. */
const JWT_REUSE_SECONDS = 1500;

export class KlingClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cachedJwt: { token: string; issuedAtSeconds: number } | null = null;

  constructor(private readonly opts: KlingClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    if (!/^https:\/\//.test(opts.baseUrl)) throw new Error('Kling base URL must be https://');
  }

  get authScheme(): KlingCredential['kind'] {
    return this.opts.credential.kind;
  }

  /** Bearer value for the Authorization header. Never log the result. */
  async bearerToken(): Promise<string> {
    const cred = this.opts.credential;
    if (cred.kind === 'api_key') return cred.apiKey;

    const nowSeconds = Math.floor(this.now() / 1000);
    if (this.cachedJwt && nowSeconds - this.cachedJwt.issuedAtSeconds < JWT_REUSE_SECONDS) {
      return this.cachedJwt.token;
    }
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(cred.accessKey)
      .setExpirationTime(nowSeconds + JWT_LIFETIME_SECONDS)
      .setNotBefore(nowSeconds - JWT_NOT_BEFORE_SKEW_SECONDS)
      .sign(new TextEncoder().encode(cred.secretKey));
    this.cachedJwt = { token, issuedAtSeconds: nowSeconds };
    return token;
  }

  /**
   * Submits one image-to-video task. Exactly one HTTP attempt: a paid
   * submission is never retried here, because a retry after an ambiguous
   * failure is how duplicate charges happen.
   */
  async createImageToVideo(body: ImageToVideoRequest, signal: AbortSignal): Promise<KlingTask> {
    return this.call<KlingTask>('POST', '/v1/videos/image2video', body, signal);
  }

  async getImageToVideoTask(taskOrExternalId: string, signal: AbortSignal): Promise<KlingTask> {
    return this.call<KlingTask>(
      'GET',
      `/v1/videos/image2video/${encodeURIComponent(taskOrExternalId)}`,
      undefined,
      signal,
    );
  }

  /** Resource packs and their remaining quantity. Free to call; the docs ask for QPS <= 1. */
  async getResourcePacks(signal: AbortSignal): Promise<KlingResourcePack[]> {
    const end = this.now();
    const start = end - 365 * 24 * 3600 * 1000;
    const data = await this.call<{ resource_pack_subscribe_infos?: KlingResourcePack[] }>(
      'GET',
      `/account/costs?start_time=${start}&end_time=${end}`,
      undefined,
      signal,
    );
    return data.resource_pack_subscribe_infos ?? [];
  }

  /**
   * Streams a result video to `destPath` through a temporary file, so a
   * partial download never masquerades as a finished one. Aborts past
   * `maxBytes`. No credential is sent: result URLs are pre-signed by Kling.
   */
  async downloadToFile(url: string, destPath: string, maxBytes: number, signal: AbortSignal): Promise<number> {
    if (!/^https:\/\//.test(url)) throw new KlingApiError(0, -1, 'Result URL is not https.', undefined);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal, redirect: 'error' });
    } catch (err) {
      throw new KlingNetworkError(`Download did not start: ${(err as Error).message}`, 'request');
    }
    if (!res.ok || !res.body) {
      throw new KlingApiError(res.status, -1, `Result download returned HTTP ${res.status}.`, undefined);
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      throw new KlingApiError(res.status, -1, `Result is ${declared} bytes, above the ${maxBytes}-byte limit.`, undefined);
    }

    mkdirSync(dirname(destPath), { recursive: true });
    const tmpPath = `${destPath}.part`;
    let received = 0;
    const counter = new (await import('node:stream')).Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > maxBytes) {
          cb(new KlingApiError(0, -1, `Result exceeded the ${maxBytes}-byte limit while downloading.`, undefined));
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(tmpPath, { flags: 'wx' }), { signal });
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* nothing to remove */ }
      if (err instanceof KlingApiError) throw err;
      throw new KlingNetworkError(`Download failed part-way: ${(err as Error).message}`, 'response');
    }
    renameSync(tmpPath, destPath);
    return received;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.bearerToken()}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers, signal, redirect: 'error' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, init);
    } catch (err) {
      throw new KlingNetworkError(`No response from Kling: ${(err as Error).message}`, 'request');
    }

    let envelope: KlingEnvelope<T> | undefined;
    try {
      envelope = (await res.json()) as KlingEnvelope<T>;
    } catch {
      throw new KlingApiError(res.status, -1, `Kling returned HTTP ${res.status} with a non-JSON body.`, undefined);
    }

    if (!res.ok || envelope.code !== 0) {
      throw new KlingApiError(
        res.status,
        typeof envelope.code === 'number' ? envelope.code : -1,
        envelope.message || `Kling returned HTTP ${res.status}.`,
        envelope.request_id,
      );
    }
    if (envelope.data === undefined) {
      throw new KlingApiError(res.status, -1, 'Kling returned success with no data.', envelope.request_id);
    }
    return envelope.data;
  }
}
