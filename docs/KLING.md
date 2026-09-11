# Kling AI image-to-video

Three opt-in tools that let Claude.ai animate an existing image through
Kling AI's image-to-video API, check the job, and pull the finished video onto
carbo-server. They are the gateway's first tools above Level 1, and they are
**off unless deliberately enabled** (see [Enabling](#enabling)).

| Tool | Does | Costs money |
|---|---|---|
| `kling_animate_image` | Submits one image-to-video job from an approved image and a motion prompt | **Yes, per job** |
| `kling_video_status` | Reports a job's status, failure reason, result URL and units deducted | No |
| `kling_download_video` | Saves a finished video into the approved output directory and returns its link | No |

Preservation is the design goal. The supplied image is always sent as Kling's
documented starting image (`image` on `POST /v1/videos/image2video`). There is
no code path that falls back to text-to-video: if the image cannot be read or
is rejected, nothing is submitted. By default the prompt is wrapped in a
preservation preset (single shot, locked camera, minimal motion, keep the face,
artwork style, composition, colors, logos, lettering and background), and every
response repeats that **generative video cannot guarantee exact preservation**.

---

## What the Kling API actually is

Taken from the official reference at <https://kling.ai/document-api> on
2026-09-11. Nothing below is inferred from third-party wrappers.

**Authentication.** Two schemes exist, and the answer to "API key or key pair"
is *either*:

- **API Key** — sent verbatim as `Authorization: Bearer <key>`. The docs mark
  it "for all models". This is the scheme to use for a new key.
- **Access Key / Secret Key** — the caller signs an HS256 JWT
  `{ iss: <access key>, exp: now+1800, nbf: now-5 }` with the secret key and
  sends *that* as the Bearer token. The docs scope this scheme to the legacy
  request design (model named in the body), which is the design this gateway
  uses, so it works here too. The gateway signs and caches the JWT itself.

**Base URL.** `https://api-singapore.klingai.com` for callers outside China.
The docs note the endpoint moved here from `api.klingai.com`.

**Endpoints used.**

| Call | Method and path | Notes |
|---|---|---|
| Create task | `POST /v1/videos/image2video` | Body: `model_name`, `image`, `prompt`, `negative_prompt`, `multi_shot`, `duration`, `mode`, `sound`, `external_task_id` |
| Query task | `GET /v1/videos/image2video/{id}` | `id` is the `task_id` or the `external_task_id` given at creation |
| Resource packs | `GET /account/costs?start_time&end_time` | Free; the docs ask for QPS ≤ 1. Used only by `dry_run` |

**Image input.** Base64 of the file *without* any `data:` prefix, or a URL Kling
can fetch. `.jpg`, `.jpeg`, `.png`; ≤ 10 MB; each side ≥ 300 px; aspect ratio
between 1:2.5 and 2.5:1. The gateway enforces the format and size before
submitting; Kling enforces the dimensions and rejects with code 1201.

**Models and settings offered.** Limits come from each model's own page. In
the legacy request design `mode` carries the resolution: `std` = 720p,
`pro` = 1080p, `4k` = 4K.

| `model` | `duration` (s) | `mode` | `sound` |
|---|---|---|---|
| `kling-v2-6` (default) | 5, 10 | std, pro | on/off; `on` needs `pro` (native audio is 1080p only) |
| `kling-v3` | 3 – 15 | std, pro, 4k | on/off |
| `kling-v2-5-turbo` | 5, 10 | std, pro | off only |

A value the chosen model does not support is refused with `invalid_input`
before any request is made. `multi_shot` is always sent as `false`. Camera
control is expressed in the prompt: Kling's `camera_control` object has no
documented "no movement" setting, so it is not sent.

**Task states.** `submitted` → `processing` → `succeed` or `failed`
(`task_status_msg` carries the reason). Result URLs are deleted by Kling
**30 days** after generation. After completion the task carries
`final_unit_deduction` and `final_balance_deduction`, which the status tool
returns as `cost`.

**Cost before submission.** The API publishes no per-job price. `dry_run`
shows the resource packs on the account and their remaining quantity (Kling
notes a 12-hour lag on that number); the actual deduction appears on the task
once it finishes.

---

## Enabling

The default deployment is unchanged and read-only. Enabling is four steps, each
reversible, and none of them is done for you.

1. **Store the credential as a file** (never paste it into chat or an env value):

   ```bash
   cd /opt/carbo-mcp
   umask 077
   printf '%s' '<the API key from the Kling console>' > secrets/kling_api_key
   sudo chown claudebot:65532 secrets/kling_api_key && sudo chmod 0640 secrets/kling_api_key
   ```

   The gateway runs as uid 65532 and Compose bind-mounts the file verbatim, so
   group 65532 must be able to read it. For an Access Key / Secret Key pair,
   write `secrets/kling_access_key` and `secrets/kling_secret_key` the same way
   and set the two `*_FILE` variables instead of `KLING_API_KEY_FILE`.

   Then record it in Vaultwarden, as with every other secret here:
   `export BW_SESSION="$(bw unlock --raw)"; bash scripts/vault-store.sh`.

2. **Create the folders on the share.** Kling storage lives on the CarboFolder
   share, `\\10.0.0.129\Carbo_Folder\Videos\Kling`, which is
   `/mnt/linkstation-carbo-folder/Videos/Kling` on the server:

   ```bash
   mkdir -p "/mnt/linkstation-carbo-folder/Videos/Kling/input"
   ```

   Drop starting images into `Videos\Kling\input` (mounted read-only into the
   gateway); finished videos and the `.jobs` ledger land in `Videos\Kling`.
   The share is the LinkStation NAS (10.0.0.129) over CIFS with open modes, so
   no ownership change is needed. **If the NAS is unreachable, downloads fail
   and the gateway container cannot start until it is back.**

3. **Configure and enable**:

   ```bash
   cp config/kling.env.example config/kling.env      # no secrets in it; review it
   echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.kling.yml' >> .env
   ```

   `MCP_ELEVATED_TOOLS` in `kling.env` is the switch. A kling tool is
   registered only when a credential is configured **and** its name is listed;
   the registry refuses anything else above Level 1, and a listed kling tool
   with no credential aborts startup rather than registering a tool that
   cannot work.

4. **Add the scope to Keycloak and deploy**:

   ```bash
   make configure-keycloak     # idempotent; adds the carbo:kling:generate scope
   make validate && make test && make deploy
   ```

   Reconnect the Claude.ai connector once so it re-consents; the new scope is
   advertised in the resource metadata only while an elevated tool is enabled.

**Disabling:** remove the `COMPOSE_FILE` line from `.env` (or blank
`MCP_ELEVATED_TOOLS`) and run `make deploy`. The tools, the scope
advertisement, the secret mount and the two volumes all go away; the files on
the share stay.

---

## Using the tools

The connector's instructions tell the model that `kling_animate_image` is
paid, that one explicit request authorizes one job, and to use `dry_run` when
the request is not explicit. Typical flow for the example request:

> "Animate this exact DJ Carbo GOOD MORNING artwork. Move the existing cup
> slightly upward and inward toward my mouth, add gentle coffee steam, and
> give the existing gold lettering a subtle shine. Keep my face, background,
> artwork style, text, and framing unchanged."

**Preview first** (free, submits nothing):

```json
{
  "name": "kling_animate_image",
  "arguments": {
    "image": "dj-carbo-good-morning.png",
    "prompt": "Move the existing cup slightly upward and inward toward my mouth, add gentle coffee steam rising from it, and give the existing gold lettering a subtle shine.",
    "model": "kling-v2-6",
    "duration": "5",
    "mode": "pro",
    "dry_run": true
  }
}
```

The response shows `request.image` (name, bytes, and that it is sent as the
`image` field), the full prompt including the preservation preset, model,
duration, resolution, and `billing.resource_packs` with remaining quantity.

**Submit** (paid, once):

```json
{
  "name": "kling_animate_image",
  "arguments": {
    "image": "dj-carbo-good-morning.png",
    "prompt": "Move the existing cup slightly upward and inward toward my mouth, add gentle coffee steam rising from it, and give the existing gold lettering a subtle shine.",
    "model": "kling-v2-6",
    "duration": "5",
    "mode": "pro"
  }
}
```

Returns `task_id`, `external_task_id` (`carbo-mcp-<timestamp>-<hex>`),
`status: "submitted"` and `paid: true`.

**Poll:**

```json
{ "name": "kling_video_status", "arguments": { "task_id": "<task_id>" } }
```

**Download** (after `status: "succeed"`):

```json
{ "name": "kling_download_video", "arguments": { "task_id": "<task_id>", "filename": "good-morning-animated" } }
```

Returns `file`, `bytes` and `link` (`KLING_OUTPUT_LINK_BASE` + filename, by
default `\\10.0.0.129\Carbo_Folder\Videos\Kling\<file>.mp4`). Calling it
again returns the existing file without downloading.

Other arguments: `sound` (`on`/`off`), `negative_prompt` (added to the preset's
own list), `preservation_preset: false` to send the prompt verbatim, and
`allow_duplicate: true` to knowingly resubmit a job identical to one made in
the last ten minutes. An `image` may also be an `https://` URL; Kling fetches
it itself, so it must be publicly reachable. Chat attachments cannot be used:
the file has to be in `Videos\Kling\input` on the CarboFolder share first.

---

## Paid-usage and safety rules the code enforces

- **One submission per call, never retried.** A network failure after sending
  is reported as "may or may not have been created" with the
  `external_task_id` to check; it is never resubmitted.
- **Duplicate guard.** An identical image + prompt + settings within ten
  minutes is refused unless `allow_duplicate: true`.
- **`dry_run` makes no create call** and writes nothing.
- **Files.** Input is read only from the approved directory, resolved with
  realpath so symlinks and `..` cannot escape; only `.jpg/.jpeg/.png` ≤ 10 MB.
  Output goes only to the approved directory, through a `.part` temp file,
  capped at `KLING_MAX_DOWNLOAD_BYTES`, and result URLs must be `https`.
- **Credential.** Read from a file at startup, sent only in the Authorization
  header, never logged, never in a response or error. Kling's error text is
  passed through the redactor. `describeConfig` reports only the scheme.
- **Audit.** Every call is recorded like any other tool: subject, client,
  tool, required scope, parameter shapes, outcome, duration, error category.
  A small ledger in `Videos\Kling\.jobs\<task_id>.json` records what
  was submitted (model, settings, image name and hash, prompt) so the status
  tool can show it and the duplicate guard can work.
- **Annotations.** Advertised with `readOnlyHint: false`, `openWorldHint:
  true`, and the connector instructions gain a paragraph stating the
  exception to "everything is read-only".

---

## Error categories

| Kling code | Category | Meaning |
|---|---|---|
| 1000–1004 | `unavailable` | Credential rejected or expired |
| 1101 / 1102 | `unavailable` | Account in arrears / resource pack exhausted |
| 1100 / 1103 | `unavailable` | Account status, or this key may not use the model |
| 1200 / 1201 | `invalid_input` | Parameter rejected (Kling's message is included) |
| 1202 / 1203 | `not_found` | Unknown method or task |
| 1300 / 1301 | `invalid_input` | Blocked by Kling's content policy |
| 1302 / 1303 | `upstream` | Rate or concurrency limit; not retried |
| 5000–5002 | `upstream` | Kling-side error; not retried |
| no answer | `upstream` (submit) / `unavailable` (others) | Network failure; submit outcome unknown |

---

## Verification status

**Verified with mocked responses** (`tests/kling.test.ts`, 37 tests, no
network): registry refuses the tools without the allowlist; input validation
(traversal, symlink escape, extension, size, missing file, http/data URLs,
per-model duration/mode/sound); API-key header; access/secret-key JWT (HS256,
`iss`, `exp`−`nbf` = 1805 s, verified with the secret); the submitted body
carries the fixture's exact base64 as `image`, `multi_shot: false`, no
`image_tail`, the preset prompt and negative prompt; URL pass-through; `dry_run`
submits nothing; duplicate guard; single attempt on network failure; error
mapping; status for processing/succeed/failed/unknown; download to the output
directory, idempotence, custom and watermarked filenames, size cap with no
partial file left, https-only result URLs; MCP annotations and instructions.

**Not verified, because no paid job was authorized during installation:**

- A real submission against `api-singapore.klingai.com` with Carbo's
  credential — including that the account's key is the API-Key scheme rather
  than an Access/Secret pair, and that it is entitled to `kling-v2-6`.
- That a live task's response and result URL match the documented shapes end
  to end (the mocks follow the reference examples exactly).
- The deployed container's outbound reach to Kling and its CA bundle
  (distroless ships one; not exercised here).
- The compose override in a running stack: it was merged with `docker compose
  config` against a scratch copy, not started.

**Suggested first live test** (one paid 5-second job, only when approved):
place the artwork in `Videos\Kling\input` on the share, run `kling_animate_image` with
`dry_run: true`, confirm the shown image, prompt, model, duration and quota,
then run it again without `dry_run`.
