# Telegram integration setup

The Telegram bot lets a verified sender DM the Executive and get a reply in the
same thread. Inbound messages arrive on `POST /webhook/telegram`; outbound
messages (proposals, alerts, scheduled sends) use the same bot.

Access is **roster-driven**: only senders whose Telegram `chat_id` is stored on a
non-archived `Person` row get a response. Everyone else is ignored. There is no
env-var allowlist to maintain.

## What you need

| Thing                          | Where it comes from                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`           | [@BotFather](https://t.me/BotFather) → `/newbot`                                                      |
| `TELEGRAM_WEBHOOK_SECRET`      | You invent it: any random string. Telegram echoes it back in a header, and the app rejects mismatches |
| A public HTTPS URL for the API | Telegram will not call `localhost`. Any host with a valid TLS cert works                              |
| Your Telegram `chat_id`        | Set on your `Person` row (People page) — see step 4                                                   |

Both env vars are read from the process environment (`config.py`, aliases
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET`). Leaving the token unset disables
the integration and the webhook route returns `503`.

## Setup

### 1. Create the bot and collect the token

Talk to [@BotFather](https://t.me/BotFather), run `/newbot`, and copy the token it
returns (format `<digits>:<secret>`).

### 2. Configure the environment

```bash
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)   # store this value
```

The webhook route is **exempt from the shared-secret gate** — it authenticates
itself instead, by comparing the `X-Telegram-Bot-Api-Secret-Token` header against
`TELEGRAM_WEBHOOK_SECRET` with a constant-time compare. If the secret is unset the
header check is skipped, which is why setting it is not optional in practice.

Restart the API after changing env vars.

### 3. Register the webhook

Once the API is reachable over HTTPS:

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://your-api-host/webhook/telegram" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message"]'
```

`secret_token` must match `TELEGRAM_WEBHOOK_SECRET`, or every delivery will be
rejected with `401`.

Confirm it registered:

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

Check `url` is your endpoint, `pending_update_count` is small, and
`last_error_message` is absent. Telegram retries failed deliveries, so an
endpoint that 500s will keep accumulating updates.

### 4. Add your chat_id to your Person row

This is the step that silently breaks most first attempts: the bot will receive
your message, find no matching Person, and stay quiet.

1. Send your bot any message (for example `/start`).
2. Read the update to get your numeric chat id:

   ```bash
   curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | jq '.result[-1].message.chat.id'
   ```

3. Open the People page, edit your person, and set **Telegram chat id** to that
   number. Save.

### 5. Verify

Send the bot a message. You should get a reply from the Executive. If nothing
comes back:

| Symptom                                   | Likely cause                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No reply, no logs                         | `chat_id` not set on a non-archived Person row — the roster check dropped it silently by design                      |
| `503 Telegram integration not configured` | `TELEGRAM_BOT_TOKEN` unset in the API process                                                                        |
| `401 Invalid webhook secret`              | `secret_token` in `setWebhook` differs from `TELEGRAM_WEBHOOK_SECRET`, or the API was not restarted after setting it |
| Replies work, proactive messages do not   | Outbound sends need the same token; check the person's `preferred_channel` and any per-channel tool gating           |

## Behaviour notes

- Replies longer than 2000 characters are split at paragraph boundaries (Telegram's
  hard limit is 4096 UTF-16 units, and emoji count double).
- Bot commands `/start`, `/help`, `/ask` are stripped before the text reaches the
  Executive.
- Messages from the same chat serialise through a per-chat lock, so two quick
  messages cannot interleave into one confused turn.
- Testing locally: Telegram cannot reach your machine, so a public tunnel is
  required for a real end-to-end test. Keep that tunnel temporary; the deployed
  host is the supported path.

## Related

- `docs/architecture.md` — integration overview and the full env-var table.
- `docs/auth.md` — which routes verify their own secrets instead of the shared
  secret.
- `docs/google_chat_setup.md` — the Google Chat equivalent.
