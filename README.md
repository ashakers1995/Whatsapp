# WhatsApp → Obsidian Pipeline

Captures WhatsApp messages you send to a specific number and forwards them to
an n8n webhook, which writes them into your Obsidian vault (via Dropbox sync).

Connects to WhatsApp using [Baileys](https://github.com/WhiskeySockets/Baileys)
(QR-linked device method), **not** the official Meta Business API — this
avoids Meta business verification, but it does mean this uses your personal
WhatsApp account as a linked device.

## How it works

1. The script connects to WhatsApp as a linked device (like WhatsApp Web).
2. It watches for messages **you send** to `TARGET_PHONE_NUMBER` (default
   `+971564949243`).
3. If the message text contains a 📌 emoji, the emoji is stripped and the
   remaining text is POSTed to your n8n webhook as:
   ```json
   { "from": "971564949243@s.whatsapp.net", "text": "your note text", "timestamp": 1737000000000 }
   ```
4. Messages without 📌 are ignored — this is your "capture to Obsidian"
   trigger convention. Send yourself a normal message to that number and
   nothing happens; prefix/include 📌 and it gets captured.
5. The n8n workflow (built separately, not part of this repo) receives the
   webhook and writes a note into your Obsidian vault folder, which Dropbox
   syncs to your devices.

## a) Setting environment variables in Railway

In your Railway project, go to the service → **Variables** tab, and add:

| Variable | Description |
|---|---|
| `N8N_WEBHOOK_URL` | Your n8n webhook URL that receives the captured note |
| `DROPBOX_ACCESS_TOKEN` | Dropbox API access token used to persist the WhatsApp session |
| `TARGET_PHONE_NUMBER` | *(optional)* Digits-only phone number to watch, defaults to `971564949243` |
| `DROPBOX_SESSION_PATH` | *(optional)* Dropbox path for the session zip, defaults to `/whatsapp-obsidian/auth_info.zip` |
| `DROPBOX_QR_PATH` | *(optional)* Dropbox path for the QR code PNG, defaults to `/whatsapp-qr.png` |
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
  set by `DROPBOX_SESSION_PATH`) and extracts it into the local `auth_info/`
  folder *before* connecting to WhatsApp. If nothing exists yet in Dropbox
  (first run), it just starts fresh and a QR scan is required.
- **On every `creds.update` event** (Baileys fires this whenever the auth
  state changes, e.g. after linking or periodic key rotation), the script
  re-zips the local `auth_info/` folder and overwrites the copy in Dropbox.
- This means the session survives redeploys, and you only need to scan the
  QR code once — unless you explicitly log out from your phone (WhatsApp →
  Linked Devices → remove this device), in which case Baileys reports a
  `loggedOut` disconnect reason, the script stops auto-reconnecting, and
  you'll need to delete the stale session from Dropbox and redeploy to scan
  a fresh QR.

## d) The 📌 trigger convention

Only messages **you send** to `TARGET_PHONE_NUMBER` that contain a 📌 emoji
are captured. This keeps the pipeline opt-in per message: use that chat as a
scratchpad and prefix anything you want saved to Obsidian with 📌, e.g.:

```
📌 Idea: try batching the Dropbox uploads instead of on every creds update
```

The 📌 is stripped before the text is sent to n8n, so your Obsidian note
just contains the clean message text.

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
