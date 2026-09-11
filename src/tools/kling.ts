/**
 * Kling AI image-to-video tools. Level 3: they reach a third party and
 * kling_animate_image spends money.
 *
 * Three rules shape everything here:
 *
 *  1. The supplied image is always sent as Kling's documented starting image
 *     (`image` on POST /v1/videos/image2video). There is no path that quietly
 *     degrades to text-to-video: if the image cannot be read or is invalid the
 *     call fails before anything is submitted.
 *  2. A paid submission is made exactly once per call and never retried. An
 *     ambiguous failure is reported as "unknown, check status", not resubmitted.
 *  3. Files are read only from the approved input directory and written only to
 *     the approved output directory; both are validated with realpath so a
 *     symlink cannot point elsewhere.
 *
 * Model limits below come from each model's own page in the official reference
 * (https://kling.ai/document-api, fetched 2026-09-11): kling-v2-5-turbo and
 * kling-v2-6 offer 5 s or 10 s at 720p/1080p; kling-v2-6 additionally offers
 * native audio, 1080p only; kling-v3 offers 3–15 s at 720p/1080p/4K with audio.
 * In the legacy request design used here `mode` carries the resolution:
 * std = 720p, pro = 1080p, 4k = 4K.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { KlingConfig } from '../config.js';
import {
  KlingApiError,
  KlingClient,
  KlingNetworkError,
  type ImageToVideoRequest,
  type KlingTask,
} from '../adapters/kling.js';
import { redactString } from '../logging/redact.js';
import { ToolError, type ToolDefinition } from './registry.js';

export const KLING_SCOPE = 'carbo:kling:generate' as const;

const MODEL_NAMES = ['kling-v2-6', 'kling-v3', 'kling-v2-5-turbo'] as const;
type ModelName = (typeof MODEL_NAMES)[number];

const ALL_DURATIONS = ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'] as const;
const ALL_MODES = ['std', 'pro', '4k'] as const;

interface ModelCapabilities {
  durations: readonly string[];
  modes: readonly string[];
  sound: boolean;
  /** kling-v2-6 documents native audio for 1080p output only. */
  soundRequiresMode?: 'pro';
}

export const MODEL_CAPABILITIES: Record<ModelName, ModelCapabilities> = {
  'kling-v2-5-turbo': { durations: ['5', '10'], modes: ['std', 'pro'], sound: false },
  'kling-v2-6': { durations: ['5', '10'], modes: ['std', 'pro'], sound: true, soundRequiresMode: 'pro' },
  'kling-v3': { durations: ALL_DURATIONS, modes: ALL_MODES, sound: true },
};

const MODE_RESOLUTION: Record<string, string> = { std: '720p', pro: '1080p', '4k': '4K' };

/** Documented limits for the `image` field. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const PROMPT_MAX_CHARS = 2500;

/**
 * The preservation preset. Kling's own guidance is to state negatives inside
 * the positive prompt, which is why the "keep" clauses are here and the
 * negative_prompt merely repeats them.
 */
export const PRESERVATION_PREFIX =
  'Animate this exact image. Keep everything not mentioned below exactly as in the original: ' +
  'the same person and face, the same artwork style, the same composition and framing, the same colors, ' +
  'the same logos, lettering and text (unchanged and fully legible), and the same background. ' +
  'Single continuous shot with no cuts. Locked, static camera: no camera movement, no zoom, no pan, no tilt. ' +
  'Subtle, minimal, natural motion only. Animate only the following: ';

export const PRESERVATION_NEGATIVE =
  'camera movement, zoom, pan, tilt, cuts, scene change, new objects, new people, altered face, ' +
  'altered or garbled text and lettering, style change, color shift, background change, distortion';

const PRESERVATION_NOTE =
  'Generative video cannot guarantee exact preservation. The prompt asks Kling to keep the face, style, ' +
  'composition, colors, logos, lettering and background unchanged, but small drift is possible; review the result.';

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const LEDGER_SCAN_LIMIT = 500;

const taskIdentifier = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, _ and - only')
  .describe('Kling task_id, or the external_task_id this gateway assigned (carbo-mcp-...).');

export interface KlingToolDeps {
  client: KlingClient;
  kling: KlingConfig;
  /** Names to enable. Anything not listed is registered disabled and never advertised. */
  enabled: Set<string>;
}

/** What the gateway remembers about a submission, kept beside the output files. */
interface LedgerEntry {
  task_id: string;
  external_task_id: string;
  fingerprint: string;
  model: string;
  duration_seconds: number;
  mode: string;
  resolution: string;
  sound: string;
  image: { kind: 'local' | 'url'; name: string; sha256?: string };
  prompt: string;
  negative_prompt?: string;
  submitted_at: string;
  subject: string;
  downloaded_file?: string;
}

type ResolvedImage =
  | { kind: 'url'; value: string; name: string }
  | { kind: 'local'; value: string; name: string; bytes: number; sha256: string };

function defineTool<T extends z.ZodTypeAny>(def: ToolDefinition<T>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

// ------------------------------------------------------------------ helpers

function hasTraversal(input: string): boolean {
  if (input.includes('\0')) return true;
  if (input.startsWith('/') || input.startsWith('\\') || /^[A-Za-z]:/.test(input)) return true;
  return input.split(/[\\/]+/).some((seg) => seg === '..');
}

function listImages(inputDir: string, limit = 25): string[] {
  try {
    return readdirSync(inputDir)
      .filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Turns the caller's `image` argument into what Kling's `image` field needs:
 * an https URL passed through, or a file from the approved directory as raw
 * base64. Anything else is refused here, before any request is made.
 */
export function resolveImage(input: string, inputDir: string): ResolvedImage {
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    if (/^data:/i.test(input)) {
      throw new ToolError(
        'invalid_input',
        'Inline base64 images are not accepted. Save the file into the approved image directory and pass its filename, or give an https:// URL.',
      );
    }
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new ToolError('invalid_input', 'The image URL could not be parsed.');
    }
    if (url.protocol !== 'https:') {
      throw new ToolError('invalid_input', 'Image URLs must use https://. Kling fetches the URL itself, so it must be publicly reachable.');
    }
    if (url.username || url.password) {
      throw new ToolError('invalid_input', 'Image URLs must not embed credentials.');
    }
    return { kind: 'url', value: url.toString(), name: url.pathname.split('/').pop() || url.hostname };
  }

  if (hasTraversal(input)) {
    throw new ToolError('invalid_input', 'The image must be a filename inside the approved image directory; absolute paths and ".." are not allowed.');
  }

  let realInput: string;
  try {
    realInput = realpathSync(inputDir);
  } catch {
    throw new ToolError('unavailable', 'The approved image directory is not mounted. Check KLING_INPUT_DIR and the compose volume.');
  }

  const candidate = resolve(realInput, input);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    const available = listImages(realInput);
    throw new ToolError(
      'not_found',
      `No image named "${input}" in the approved image directory.` +
        (available.length > 0 ? ` Available: ${available.join(', ')}.` : ' The directory currently holds no .jpg/.jpeg/.png files.'),
    );
  }
  if (!real.startsWith(realInput + sep)) {
    throw new ToolError('invalid_input', 'The image resolves outside the approved image directory and was refused.');
  }
  const ext = extname(real).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new ToolError('invalid_input', `Kling accepts .jpg, .jpeg and .png starting images; "${input}" is ${ext || 'extensionless'}.`);
  }
  const st = statSync(real);
  if (!st.isFile()) throw new ToolError('invalid_input', `"${input}" is not a regular file.`);
  if (st.size > IMAGE_MAX_BYTES) {
    throw new ToolError('invalid_input', `"${input}" is ${st.size} bytes; Kling's documented limit for the starting image is 10 MB.`);
  }
  if (st.size === 0) throw new ToolError('invalid_input', `"${input}" is empty.`);

  const bytes = readFileSync(real);
  return {
    kind: 'local',
    // Raw base64 with no data: prefix, exactly as the reference requires.
    value: bytes.toString('base64'),
    name: input,
    bytes: st.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Maps a Kling service code to a stable category and an operator-facing hint. */
export function mapKlingError(err: KlingApiError, action: string): ToolError {
  const code = err.serviceCode;
  const detail = redactString(err.message);
  const ref = err.requestId ? ` (Kling request ${err.requestId})` : '';
  const base = `Kling ${action} failed with HTTP ${err.httpStatus}, code ${code}: ${detail}${ref}.`;

  if (code >= 1000 && code <= 1004) {
    return new ToolError('unavailable', `${base} The credential was rejected: check the secret file named by KLING_API_KEY_FILE (or the access/secret key pair) and that it has not expired or been revoked.`);
  }
  if (code === 1101) return new ToolError('unavailable', `${base} The Kling account is in arrears; recharge it before submitting again.`);
  if (code === 1102) return new ToolError('unavailable', `${base} The resource pack is exhausted or expired; purchase more before submitting again.`);
  if (code === 1100 || code === 1103) return new ToolError('unavailable', `${base} Check the account status and that this key may use the requested model.`);
  if (code === 1200 || code === 1201) return new ToolError('invalid_input', `${base} Kling rejected a parameter; adjust the request.`);
  if (code === 1202 || code === 1203) return new ToolError('not_found', base);
  if (code === 1300 || code === 1301) return new ToolError('invalid_input', `${base} Kling's content policy blocked it; change the prompt or image.`);
  if (code === 1302 || code === 1303) {
    return new ToolError('upstream', `${base} Rate or concurrency limit reached. Nothing was retried automatically: wait for running jobs to finish, then submit again deliberately.`);
  }
  if (code === 1304) return new ToolError('unavailable', `${base} Kling's IP allowlist policy blocked this server.`);
  if (code >= 5000) return new ToolError('upstream', `${base} Kling-side error; nothing was retried automatically.`);
  return new ToolError('upstream', base);
}

function readLedger(dir: string, id: string): LedgerEntry | undefined {
  const direct = join(dir, `${id}.json`);
  if (existsSync(direct)) {
    try {
      return JSON.parse(readFileSync(direct, 'utf8')) as LedgerEntry;
    } catch {
      return undefined;
    }
  }
  for (const entry of scanLedger(dir)) {
    if (entry.external_task_id === id) return entry;
  }
  return undefined;
}

function scanLedger(dir: string): LedgerEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, LEDGER_SCAN_LIMIT);
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as LedgerEntry);
    } catch {
      // A damaged ledger file is skipped, never fatal.
    }
  }
  return out;
}

function writeLedger(dir: string, entry: LedgerEntry): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${entry.task_id}.json`), JSON.stringify(entry, null, 2), { mode: 0o640 });
}

function linkFor(base: string, filename: string): string {
  if (!base) return filename;
  return base.endsWith('/') ? `${base}${filename}` : `${base}/${filename}`;
}

function summarizeTask(task: KlingTask, ledger: LedgerEntry | undefined) {
  const video = task.task_result?.videos?.[0];
  const status = task.task_status;
  return {
    task_id: task.task_id,
    external_task_id: task.task_info?.external_task_id ?? ledger?.external_task_id,
    status,
    done: status === 'succeed' || status === 'failed',
    ...(status === 'failed'
      ? { failure_reason: task.task_status_msg ? redactString(task.task_status_msg) : 'Kling gave no reason.' }
      : {}),
    ...(status === 'succeed' && video
      ? {
          video: {
            url: video.url,
            watermark_url: video.watermark_url,
            duration_seconds: video.duration ? Number(video.duration) : undefined,
            note: 'Kling removes result files 30 days after generation; download promptly.',
          },
        }
      : {}),
    ...(task.final_unit_deduction || task.final_balance_deduction
      ? {
          cost: {
            units_deducted: task.final_unit_deduction,
            balance_quota: task.final_balance_deduction?.quota,
            balance_list_price: task.final_balance_deduction?.list_price,
          },
        }
      : {}),
    created_at: task.created_at ? new Date(task.created_at).toISOString() : undefined,
    updated_at: task.updated_at ? new Date(task.updated_at).toISOString() : undefined,
    ...(ledger
      ? {
          submitted: {
            model: ledger.model,
            duration_seconds: ledger.duration_seconds,
            resolution: ledger.resolution,
            sound: ledger.sound,
            image: ledger.image.name,
            prompt: ledger.prompt,
            at: ledger.submitted_at,
            ...(ledger.downloaded_file ? { downloaded_file: ledger.downloaded_file } : {}),
          },
        }
      : {}),
  };
}

// -------------------------------------------------------------------- tools

export function buildKlingTools(deps: KlingToolDeps): ToolDefinition[] {
  const { client, kling, enabled } = deps;
  const ledgerDir = join(kling.outputDir, '.jobs');
  const tools: ToolDefinition[] = [];

  async function fetchTask(id: string, signal: AbortSignal): Promise<KlingTask> {
    try {
      return await client.getImageToVideoTask(id, signal);
    } catch (err) {
      if (err instanceof KlingApiError) {
        if (err.httpStatus === 404) throw new ToolError('not_found', `Kling has no image-to-video task "${id}".`);
        throw mapKlingError(err, 'status query');
      }
      if (err instanceof KlingNetworkError) throw new ToolError('unavailable', `Kling could not be reached: ${redactString(err.message)}`);
      throw err;
    }
  }

  tools.push(defineTool({
    name: 'kling_animate_image',
    title: 'Animate an image with Kling AI (paid)',
    description:
      'Submits a PAID Kling AI image-to-video job that animates an existing image. The supplied image is ' +
      'always sent as the starting frame (Kling\'s `image` field); this never falls back to text-to-video. ' +
      'By default the prompt is wrapped in a preservation preset: single shot, locked camera, minimal motion, ' +
      'and keep the face, artwork style, composition, colors, logos, lettering and background unchanged. ' +
      'Generative video cannot guarantee exact preservation. ' +
      'Returns the task id and initial status; poll with kling_video_status, then fetch with kling_download_video. ' +
      'Each call submits at most one job and never retries. Only call this when the operator explicitly asked to ' +
      'generate; if unsure, call with dry_run: true first, which shows the exact image, prompt, model, duration ' +
      'and available quota without submitting or charging anything. ' +
      'It cannot read files outside the approved image directory, cannot accept chat attachments, and cannot ' +
      'generate without a starting image.',
    scope: KLING_SCOPE,
    risk: 3,
    enabled: enabled.has('kling_animate_image'),
    timeoutMs: 25000,
    inputSchema: z.object({
      image: z
        .string()
        .min(1)
        .max(2048)
        .describe('Filename inside the approved image directory (for example "good-morning.png"), or an https:// URL to a .jpg/.jpeg/.png. Chat attachments cannot be used directly; the file must be placed in the directory first.'),
      prompt: z
        .string()
        .min(3)
        .max(1500)
        .describe('What should move, in plain language. With the preset (default) this is appended to instructions to keep everything else unchanged.'),
      model: z.enum(MODEL_NAMES).default('kling-v2-6').describe('kling-v2-6: 5 or 10 s, 720p/1080p, optional audio at 1080p. kling-v3: 3–15 s, 720p/1080p/4K, optional audio. kling-v2-5-turbo: 5 or 10 s, 720p/1080p, no audio.'),
      duration: z.enum(ALL_DURATIONS).default('5').describe('Seconds. Must be one the selected model supports.'),
      mode: z.enum(ALL_MODES).default('std').describe('Output resolution: std = 720p, pro = 1080p, 4k = 4K (kling-v3 only).'),
      sound: z.enum(['on', 'off']).default('off').describe('Native audio. kling-v2-6 requires mode "pro"; kling-v2-5-turbo does not support it.'),
      negative_prompt: z.string().max(500).optional().describe('Extra things to avoid. Appended to the preset\'s own negative list when the preset is on.'),
      preservation_preset: z.boolean().default(true).describe('Wrap the prompt in the preservation instructions (single shot, locked camera, keep face/style/text/background). Set false to send the prompt verbatim.'),
      dry_run: z.boolean().default(false).describe('Validate everything and show exactly what would be submitted, plus available quota, without submitting or charging.'),
      allow_duplicate: z.boolean().default(false).describe('Permit a submission identical to one made in the last 10 minutes. Off by default to prevent accidental double charges.'),
    }),
    outputSchema: z.object({
      submitted: z.boolean(),
      paid: z.boolean(),
      task_id: z.string().optional(),
      external_task_id: z.string(),
      status: z.string().optional(),
      request: z.object({
        model: z.string(),
        duration_seconds: z.number(),
        resolution: z.string(),
        sound: z.string(),
        single_shot: z.literal(true),
        image: z.object({ source: z.string(), name: z.string(), bytes: z.number().optional(), sent_as: z.string() }),
        prompt: z.string(),
        negative_prompt: z.string().optional(),
      }),
      preservation_note: z.string(),
      billing: z.object({
        note: z.string(),
        resource_packs: z.array(z.object({ name: z.string().optional(), type: z.string().optional(), remaining: z.number().optional(), total: z.number().optional(), status: z.string().optional(), expires_at: z.string().optional() })).optional(),
      }),
      next_step: z.string(),
    }),
    handler: async (input, ctx) => {
      const caps = MODEL_CAPABILITIES[input.model];
      if (!caps.durations.includes(input.duration)) {
        throw new ToolError('invalid_input', `${input.model} supports durations of ${caps.durations.join(', ')} seconds, not ${input.duration}.`);
      }
      if (!caps.modes.includes(input.mode)) {
        throw new ToolError('invalid_input', `${input.model} supports mode ${caps.modes.join(', ')}; "${input.mode}" is not available on it.`);
      }
      if (input.sound === 'on') {
        if (!caps.sound) throw new ToolError('invalid_input', `${input.model} does not support native audio; set sound to "off" or choose kling-v2-6 or kling-v3.`);
        if (caps.soundRequiresMode && input.mode !== caps.soundRequiresMode) {
          throw new ToolError('invalid_input', `${input.model} generates native audio only at 1080p; set mode to "${caps.soundRequiresMode}" or sound to "off".`);
        }
      }

      const image = resolveImage(input.image, kling.inputDir);

      const prompt = input.preservation_preset ? `${PRESERVATION_PREFIX}${input.prompt.trim()}` : input.prompt.trim();
      if (prompt.length > PROMPT_MAX_CHARS) {
        throw new ToolError('invalid_input', `The final prompt is ${prompt.length} characters; Kling's limit is ${PROMPT_MAX_CHARS}.`);
      }
      const negativeParts = [
        ...(input.preservation_preset ? [PRESERVATION_NEGATIVE] : []),
        ...(input.negative_prompt?.trim() ? [input.negative_prompt.trim()] : []),
      ];
      const negativePrompt = negativeParts.length > 0 ? negativeParts.join(', ') : undefined;

      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const externalTaskId = `carbo-mcp-${stamp}-${randomBytes(3).toString('hex')}`;
      const fingerprint = createHash('sha256')
        .update([input.model, input.duration, input.mode, input.sound, image.kind === 'local' ? image.sha256 : image.value, prompt, negativePrompt ?? ''].join('\n'))
        .digest('hex');

      const request = {
        model: input.model,
        duration_seconds: Number(input.duration),
        resolution: MODE_RESOLUTION[input.mode] ?? input.mode,
        sound: input.sound,
        single_shot: true as const,
        image: {
          source: image.kind === 'local' ? 'approved image directory' : 'https URL (fetched by Kling)',
          name: image.name,
          ...(image.kind === 'local' ? { bytes: image.bytes } : {}),
          sent_as: image.kind === 'local' ? 'Kling `image` field, raw base64 of the file' : 'Kling `image` field, the URL as given',
        },
        prompt,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      };

      const billingNote =
        'Kling bills per generated video from the account\'s resource packs or balance; the exact charge is not ' +
        'published by the API before submission and appears on the task (units_deducted) once it finishes.';

      if (input.dry_run) {
        let packs: Array<Record<string, unknown>> | undefined;
        let packNote = '';
        try {
          packs = (await client.getResourcePacks(ctx.signal)).map((p) => ({
            name: p.resource_pack_name,
            type: p.resource_pack_type,
            remaining: p.remaining_quantity,
            total: p.total_quantity,
            status: p.status,
            expires_at: p.invalid_time ? new Date(p.invalid_time).toISOString() : undefined,
          }));
        } catch (err) {
          packNote = ` Quota lookup failed: ${redactString(err instanceof Error ? err.message : String(err))}.`;
        }
        return {
          submitted: false,
          paid: false,
          external_task_id: externalTaskId,
          request,
          preservation_note: PRESERVATION_NOTE,
          billing: { note: billingNote + packNote, ...(packs ? { resource_packs: packs } : {}) },
          next_step: 'Nothing was submitted. Call again with dry_run: false to submit this exact job once the operator approves.',
        };
      }

      if (!input.allow_duplicate) {
        const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
        const twin = scanLedger(ledgerDir).find((e) => e.fingerprint === fingerprint && Date.parse(e.submitted_at) >= cutoff);
        if (twin) {
          const minutes = Math.max(1, Math.round((Date.now() - Date.parse(twin.submitted_at)) / 60000));
          throw new ToolError(
            'invalid_input',
            `An identical job (task ${twin.task_id}) was submitted ${minutes} minute(s) ago and was not resubmitted. ` +
              'Check it with kling_video_status, or pass allow_duplicate: true to pay for another run deliberately.',
          );
        }
      }

      const body: ImageToVideoRequest = {
        model_name: input.model,
        image: image.value,
        prompt,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        multi_shot: false,
        duration: input.duration,
        mode: input.mode,
        sound: input.sound,
        external_task_id: externalTaskId,
      };

      let task: KlingTask;
      try {
        task = await client.createImageToVideo(body, ctx.signal);
      } catch (err) {
        if (err instanceof KlingNetworkError) {
          throw new ToolError(
            'upstream',
            `Kling did not answer the submission (${redactString(err.message)}). The job may or may not have been created and ` +
              `was NOT resubmitted. Before trying again, run kling_video_status with task_id "${externalTaskId}": ` +
              'not_found means it was never created; anything else means it exists.',
          );
        }
        if (err instanceof KlingApiError) throw mapKlingError(err, 'submission');
        throw err;
      }

      writeLedger(ledgerDir, {
        task_id: task.task_id,
        external_task_id: externalTaskId,
        fingerprint,
        model: input.model,
        duration_seconds: Number(input.duration),
        mode: input.mode,
        resolution: request.resolution,
        sound: input.sound,
        image: { kind: image.kind, name: image.name, ...(image.kind === 'local' ? { sha256: image.sha256 } : {}) },
        prompt,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        submitted_at: new Date().toISOString(),
        subject: ctx.subject,
      });

      return {
        submitted: true,
        paid: true,
        task_id: task.task_id,
        external_task_id: externalTaskId,
        status: task.task_status,
        request,
        preservation_note: PRESERVATION_NOTE,
        billing: { note: billingNote },
        next_step: `Poll kling_video_status with task_id "${task.task_id}" (typically a few minutes), then kling_download_video.`,
      };
    },
  }));

  tools.push(defineTool({
    name: 'kling_video_status',
    title: 'Kling job status',
    description:
      'Checks one Kling image-to-video job by task_id or external_task_id and returns its status ' +
      '(submitted, processing, succeed, failed), the failure reason when it failed, the result URL and duration ' +
      'when it succeeded, the units deducted once known, and what was submitted. Free to call. ' +
      'It cannot cancel, modify or resubmit a job and never charges anything.',
    scope: KLING_SCOPE,
    risk: 3,
    enabled: enabled.has('kling_video_status'),
    timeoutMs: 10000,
    inputSchema: z.object({ task_id: taskIdentifier }),
    outputSchema: z.object({
      task_id: z.string(),
      external_task_id: z.string().optional(),
      status: z.string(),
      done: z.boolean(),
      failure_reason: z.string().optional(),
      video: z.object({ url: z.string().optional(), watermark_url: z.string().optional(), duration_seconds: z.number().optional(), note: z.string() }).optional(),
      cost: z.object({ units_deducted: z.string().optional(), balance_quota: z.string().optional(), balance_list_price: z.string().optional() }).optional(),
      created_at: z.string().optional(),
      updated_at: z.string().optional(),
      submitted: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: async (input, ctx) => {
      const task = await fetchTask(input.task_id, ctx.signal);
      return summarizeTask(task, readLedger(ledgerDir, task.task_id) ?? readLedger(ledgerDir, input.task_id));
    },
  }));

  tools.push(defineTool({
    name: 'kling_download_video',
    title: 'Download a finished Kling video',
    description:
      'Downloads a succeeded Kling job\'s video into the approved output directory and returns the file link. ' +
      'If the file is already there it is returned without downloading again. Free to call. ' +
      'It cannot write anywhere but the approved output directory, cannot fetch a job that has not succeeded, ' +
      'and never resubmits or charges anything.',
    scope: KLING_SCOPE,
    risk: 3,
    enabled: enabled.has('kling_download_video'),
    timeoutMs: 80000,
    inputSchema: z.object({
      task_id: taskIdentifier,
      filename: z
        .string()
        .min(1)
        .max(80)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, . _ - only')
        .optional()
        .describe('Optional output filename; ".mp4" is appended if missing. Defaults to <task_id>.mp4.'),
      watermarked: z.boolean().default(false).describe('Download the watermarked variant instead, when Kling produced one.'),
    }),
    outputSchema: z.object({
      task_id: z.string(),
      file: z.string(),
      link: z.string(),
      bytes: z.number(),
      downloaded_now: z.boolean(),
      duration_seconds: z.number().optional(),
      note: z.string(),
    }),
    handler: async (input, ctx) => {
      const task = await fetchTask(input.task_id, ctx.signal);
      if (task.task_status === 'failed') {
        throw new ToolError('upstream', `Task ${task.task_id} failed: ${redactString(task.task_status_msg ?? 'no reason given')}. There is nothing to download.`);
      }
      if (task.task_status !== 'succeed') {
        throw new ToolError('unavailable', `Task ${task.task_id} is still ${task.task_status}; check kling_video_status again shortly.`);
      }
      const video = task.task_result?.videos?.[0];
      const url = input.watermarked ? video?.watermark_url : video?.url;
      if (!url) throw new ToolError('not_found', `Task ${task.task_id} succeeded but Kling returned no ${input.watermarked ? 'watermarked ' : ''}video URL.`);

      const safeTask = task.task_id.replace(/[^A-Za-z0-9_-]/g, '_');
      let filename = input.filename ?? `${safeTask}.mp4`;
      if (!filename.toLowerCase().endsWith('.mp4')) filename = `${filename}.mp4`;

      let outDir: string;
      try {
        mkdirSync(kling.outputDir, { recursive: true });
        outDir = realpathSync(kling.outputDir);
      } catch {
        throw new ToolError('unavailable', 'The approved output directory is not writable. Check KLING_OUTPUT_DIR and the compose volume.');
      }
      const dest = resolve(outDir, filename);
      if (!dest.startsWith(outDir + sep)) throw new ToolError('invalid_input', 'The filename resolves outside the output directory.');

      const ledger = readLedger(ledgerDir, task.task_id);
      const duration = video?.duration ? Number(video.duration) : undefined;

      if (existsSync(dest) && statSync(dest).size > 0) {
        return {
          task_id: task.task_id,
          file: filename,
          link: linkFor(kling.outputLinkBase, filename),
          bytes: statSync(dest).size,
          downloaded_now: false,
          duration_seconds: duration,
          note: 'Already present in the output directory; not downloaded again.',
        };
      }

      let bytes: number;
      try {
        bytes = await client.downloadToFile(url, dest, kling.maxDownloadBytes, ctx.signal);
      } catch (err) {
        if (err instanceof KlingApiError) throw new ToolError('upstream', redactString(err.message));
        if (err instanceof KlingNetworkError) throw new ToolError('unavailable', `Download did not complete: ${redactString(err.message)}. Nothing partial was kept; try again.`);
        throw err;
      }

      if (ledger) writeLedger(ledgerDir, { ...ledger, downloaded_file: filename });

      return {
        task_id: task.task_id,
        file: filename,
        link: linkFor(kling.outputLinkBase, filename),
        bytes,
        downloaded_now: true,
        duration_seconds: duration,
        note: 'Saved to the approved output directory. Kling deletes its copy 30 days after generation.',
      };
    },
  }));

  return tools;
}
