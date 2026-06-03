# Responses WebSocket Regression SOP

This SOP verifies codex-proxy Responses WebSocket behavior after changes to:

- `src/routes/responses-ws.ts`
- `src/proxy/ws-pool.ts`
- `src/proxy/ws-transport.ts`
- `/v1/responses`, `/openai/v1/responses`, `/responses`, or `/v1/responses/compact`

The live client checks assume the EasyCEO deployment:

- local repo: `/data2/minicodex1/codex-proxy`
- remote server: `sudo ssh -p 27615 deploy@esv-bi01`
- remote deploy dir: `/usr/local/codex-proxy`
- public base URL: `https://admin.run.ceo`
- local Codex wrapper: `czkf` from `~/.bashrc`

## 1. Local Code Regression

Run from `/data2/minicodex1/codex-proxy`:

```bash
npm test -- tests/unit/routes/responses-ws.test.ts
npm test -- tests/unit/proxy/ws-pool.test.ts
npm test -- tests/unit/proxy/ws-transport.test.ts
npm test -- tests/integration/ws-pool-reuse.test.ts
npm run build
```

Pass criteria:

- `responses-ws.test.ts` passes all tests.
- `ws-pool`, `ws-transport`, and `ws-pool-reuse` pass.
- `npm run build` exits `0`.

## 2. Remote Deploy Regression

After syncing code to `/usr/local/codex-proxy`, run on the remote server:

```bash
sudo ssh -p 27615 deploy@esv-bi01 \
  'cd /usr/local/codex-proxy &&
   npm test -- tests/unit/routes/responses-ws.test.ts &&
   npm run build &&
   sudo systemctl restart codex-proxy.service &&
   systemctl is-active codex-proxy.service'
```

Pass criteria:

- Remote `responses-ws.test.ts` passes.
- Remote build exits `0`.
- `systemctl is-active codex-proxy.service` prints `active`.

## 3. Upgrade Auth Smoke Test

From the local machine, verify unauthenticated WebSocket upgrade is rejected before opening:

```bash
node - <<'NODE'
const WebSocket = require('/data2/minicodex1/codex-proxy/node_modules/ws');
const ws = new WebSocket('wss://admin.run.ceo/openai/v1/responses');
const done = (msg) => { console.log(msg); process.exit(0); };
ws.once('open', () => done('unexpected-open'));
ws.once('unexpected-response', (_req, res) => done(`unexpected-response ${res.statusCode}`));
ws.once('error', (err) => done(`error ${err.message}`));
setTimeout(() => done('timeout'), 5000);
NODE
```

Pass criteria:

- Output is `unexpected-response 401`.
- Output must not be `unexpected-open`.

## 4. czkf Default Client Smoke Test

Load the local wrapper and run a first turn:

```bash
source ~/.bashrc
czkf exec --skip-git-repo-check -C /tmp \
  -o /tmp/czkf-ws-test1.txt \
  "只回复：WS首轮OK"
```

Record the `session id` printed by Codex. Then resume that same session:

```bash
source ~/.bashrc
czkf exec resume <SESSION_ID> \
  -o /tmp/czkf-ws-test2.txt \
  "只回复：WS续句OK"
```

Pass criteria:

- First command exits `0` and final output contains `WS首轮OK`.
- Resume command exits `0` and final output contains `WS续句OK`.
- No client output contains `Falling back from WebSockets`, `401 Unauthorized`, `previous_response_not_found`, or `Malformed JSON request body`.

## 5. czkf Forced WSS Regression

This forces Codex to use the Responses WebSocket transport through the custom provider without changing persistent config.

First turn:

```bash
source ~/.bashrc
czkf exec --skip-git-repo-check -C /tmp \
  -c "model_provider=\"easyceo_codex_proxy\"" \
  -c "model_providers.easyceo_codex_proxy.supports_websockets=true" \
  -o /tmp/czkf-wss-test1.txt \
  "只回复：客户端WSS首轮OK"
```

Record the `session id`, then resume it:

```bash
source ~/.bashrc
czkf exec resume <SESSION_ID> \
  -c "model_provider=\"easyceo_codex_proxy\"" \
  -c "model_providers.easyceo_codex_proxy.supports_websockets=true" \
  -o /tmp/czkf-wss-test2.txt \
  "只回复：客户端WSS续句OK"
```

Pass criteria:

- First command exits `0` and final output contains `客户端WSS首轮OK`.
- Resume command exits `0` and final output contains `客户端WSS续句OK`.
- No client output contains `Falling back from WebSockets`, `401 Unauthorized`, `previous_response_not_found`, or `Malformed JSON request body`.

## 6. Server Log Verification for Forced WSS

Filter logs for the forced-WSS session id prefix. Use the first 8 characters after the `019...` session prefix or the full session id prefix that appears in server logs.

```bash
sudo ssh -p 27615 deploy@esv-bi01 \
  'sudo journalctl -u codex-proxy.service --since "10 minutes ago" --no-pager |
   grep -E "<SESSION_PREFIX>|previous_response_not_found|invalid_json|Falling back|Unauthorized|websocket_connection_limit_reached" |
   tail -120'
```

Pass criteria for the forced WSS two-turn session:

- First main turn has `prev=none`.
- First main turn has `ws=new:<WS_ID>`.
- Resume turn has `prev=implicit:<...>`.
- Resume turn has `affinity=hit`.
- Resume turn has `ws=reuse:<same WS_ID as first main turn>`.
- The filtered output has no `previous_response_not_found`, `invalid_json`, `Falling back`, or unexpected `Unauthorized`.

Example good pattern:

```text
[Responses] ... conv=019... prev=none ...
[Responses] ... rid=... | ws=new:ffde391a
[Responses] ... conv=019... prev=implicit:d4018fa0 resume=on ... | affinity=hit
[Responses] ... rid=... | ws=reuse:ffde391a
```

## 7. czkf Compact Regression

Use the forced-WSS session from step 5 or any recently created valid session:

```bash
source ~/.bashrc
czkf exec resume <SESSION_ID> \
  -c "model_provider=\"easyceo_codex_proxy\"" \
  -c "model_providers.easyceo_codex_proxy.supports_websockets=true" \
  -o /tmp/czkf-wss-compact.txt \
  "/compact"
```

Pass criteria:

- Command exits `0`.
- Final output contains a compact success message, for example `已压缩当前上下文。`.
- No client output contains `Malformed JSON request body`.
- Server logs within the test window do not contain `invalid_json` or `Malformed JSON`.

Check server logs:

```bash
sudo ssh -p 27615 deploy@esv-bi01 \
  'sudo journalctl -u codex-proxy.service --since "5 minutes ago" --no-pager |
   grep -E "/v1/responses/compact|/responses/compact|invalid_json|Malformed JSON|<SESSION_PREFIX>" |
   tail -120'
```

## 8. Notes for AI Reruns

- Do not modify `~/.codex-zkf/config.toml` just to run forced-WSS checks. Use `-c` overrides.
- The built-in `openai` provider cannot be overridden with `model_providers.openai.supports_websockets=true`; use `model_provider="easyceo_codex_proxy"` for forced-WSS checks.
- If `czkf` is not found, run commands through `bash -lc 'source ~/.bashrc; ...'`.
- If remote journal access fails for `deploy`, use `sudo journalctl` through the same SSH command.
- Treat unrelated `RefreshScheduler ... refresh_token_reused` account maintenance logs as noise unless they coincide with request failures.
- Keep session ids and token values out of PR comments and public logs.
