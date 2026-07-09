# WhatsApp → Obsidian Pipeline

Captures every WhatsApp message you send to yourself (the "Message Yourself"
chat) and forwards it to an n8n webhook, which writes it into your Obsidian
vault (via Dropbox sync).

Connects to WhatsApp using [Baileys](https://github.com/WhiskeySockets/Baileys)
(QR-linked device method), **not** the official Meta Business API — this
avoids Meta business verification, but it does mean this uses your personal
WhatsApp account as a linked device.

## How it works

1. The script connects to WhatsApp as a linked device (like WhatsApp Web).
2. It watches for messages in your **"Message Yourself"** chat — detected by
   comparing `msg.key.remoteJid` against **both** of your account's
   identities: the phone JID (`971...@s.whatsapp.net`) and the anonymized
   LID (`...@lid`) that newer WhatsApp versions use, combined with
   `msg.key.fromMe`. This only matches the self-chat, so outgoing messages
   in any other chat are left alone. Duplicate deliveries of the same
   message ID are filtered so a note is never forwarded twice.
3. Every text message sent in that chat is forwarded as-is to your n8n
   webhook — no marker or trigger emoji required:
   ```json
   { "from": "971564949243@s.whatsapp.net", "text": "your note text", "timestamp": 1737000000000 }
   ```
4. The n8n workflow (built separately, not part of this repo) receives the
   webhook and writes a note into your Obsidian vault folder, which Dropbox
   syncs to your devices.

## a) Setting environment variables in Railway

In your Railway project, go to the service → **Variables** tab, and add:

| Variable | Description |
|---|---|
| `N8N_WEBHOOK_URL` | Your n8n webhook URL that receives the captured note |
| `DROPBOX_ACCESS_TOKEN` | Dropbox API access token used to persist the WhatsApp session |
| `DROPBOX_SESSION_PATH` | *(optional)* Dropbox path for the session zip, defaults to `/whatsapp-obsidian/auth_info.zip` |
| `DROPBOX_QR_PATH` | *(optional)* Dropbox path for the QR code PNG, defaults to `/whatsapp-qr.png` |
| `SESSION_UPLOAD_DEBOUNCE_MS` | *(optional)* Delay after the last key write before re-uploading the session, defaults to `3000` |
| `LOG_LEVEL` | *(optional)* Baileys log verbosity, defaults to `info` |

See `.env.example` for the full list with placeholder values. **Never commit
a real `.env` file** — it's already in `.gitignore`.

To get a Dropbox access token: create an app at
[Dropbox App Console](https://www.dropbox.com/developers/apps), give it
`files.content.write` and `files.content.read` scopes, and generate an
access token (or set up OAuth refresh if you want it to never expire).

Railway will auto-detect this as a Node app via `package.json` and use
`railway.json` / `Procfile` to run `node index.js` as a worker process (no
HTTP port is opened — that's expected).

## b) First QR scan via Railway logs

1. Deploy the service on Railway with the env vars above set.
2. Open the service's **Deploy Logs** tab in the Railway dashboard.
3. On first boot (no existing session in Dropbox), the script prints a QR
   code directly in the logs, framed like:
   ```
   === Scan this QR code with WhatsApp (Linked Devices) ===
   ```
   Railway's web-based log viewer can wrap/garble this ASCII QR code and
   make it unscannable, so as a more reliable alternative the script also
   generates the QR as a PNG and uploads it to Dropbox at `DROPBOX_QR_PATH`
   (default `/whatsapp-qr.png`, overwritten on every QR event). Watch for
   this log line:
   ```
   [dropbox] QR uploaded to Dropbox at /whatsapp-qr.png - open Dropbox app on your phone to scan it.
   ```
   Then open `/whatsapp-qr.png` in the Dropbox app/website on your phone
   and scan it like a normal image.
4. On your phone: WhatsApp → **Settings → Linked Devices → Link a Device**,
   then scan the QR code (from the Railway logs or the Dropbox PNG).
5. Once linked, the log will show `[whatsapp] Connected.` and the session
   will be zipped and uploaded to Dropbox automatically — you should not
   need to scan again on future redeploys.

If the QR code expires before you scan it (Baileys times it out after a
short while), just watch the logs — a new QR is generated automatically on
each reconnect attempt.

## c) How Dropbox session persistence works

Railway's filesystem is ephemeral — every redeploy starts from a clean
container, which would normally mean re-scanning the QR code every time.
To avoid that:

- **On startup**, the script downloads `auth_info.zip` from Dropbox (path
  set by `DROPBOX_SESSION_PATH`), fully clears the local `auth_info/`
  folder, and extracts the archive into it *before* connecting to WhatsApp.
  If nothing exists yet in Dropbox (first run), it just starts fresh and a
  QR scan is required.
- **On every auth-state write** — not just `creds.update`. Baileys only
  fires `creds.update` at login/pairing moments, but the Signal key store
  (sessions, prekeys) is written on virtually every message. Both paths now
  schedule a debounced re-upload (default 3 s after the last write, tunable
  via `SESSION_UPLOAD_DEBOUNCE_MS`), so the Dropbox copy always contains
  current encryption keys. Without this, a redeploy restores stale keys and
  incoming messages fail to decrypt with `Invalid PreKey ID` /
  `No session record` errors.
- **On shutdown** (SIGTERM/SIGINT, e.g. a Railway redeploy), a final flush
  uploads the latest session before the container exits.
- This means the session survives redeploys, and you only need to scan the
  QR code once — unless you explicitly log out from your phone (WhatsApp →
  Linked Devices → remove this device), in which case Baileys reports a
  `loggedOut` disconnect reason, the script stops auto-reconnecting, and
  you'll need to delete the stale session from Dropbox and redeploy to scan
  a fresh QR.

Note: the `libsignal` library used by Baileys logs raw session objects
(including private keys) to the console. The script redacts those specific
log lines so secret key material never appears in Railway's logs.

## d) The self-chat capture convention

There's no marker or trigger emoji — every message you send in WhatsApp's
"Message Yourself" chat is captured and forwarded. Use that chat as your
Obsidian scratchpad:

```
Idea: try batching the Dropbox uploads instead of on every creds update
```

The script logs `📥 Captured self-note: <text>` in the console whenever a
message is captured, so you can confirm it fired.

## Reconnection behavior

Baileys connections can drop (network blips, WhatsApp server resets, etc).
On any disconnect that isn't an explicit logout, the script automatically
calls itself again to reconnect. On an explicit logout, it stops and logs
instructions instead of looping forever against a dead session.

## Local development

```bash
npm install
cp .env.example .env   # fill in real values
npm start
```

The QR code will print directly to your terminal on first run.
