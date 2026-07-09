require('dotenv').config();

const path = require('path');
const fs = require('fs');
const P = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const AdmZip = require('adm-zip');
const { Dropbox } = require('dropbox');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const DROPBOX_SESSION_PATH = process.env.DROPBOX_SESSION_PATH || '/whatsapp-obsidian/auth_info.zip';
const TARGET_PHONE_NUMBER = (process.env.TARGET_PHONE_NUMBER || '971564949243').replace(/\D/g, '');
const TARGET_JID = `${TARGET_PHONE_NUMBER}@s.whatsapp.net`;
const PIN_EMOJI_REGEX = /\u{1F4CC}/u;
const PIN_EMOJI_REGEX_GLOBAL = /\u{1F4CC}/gu;

const logger = P({ level: process.env.LOG_LEVEL || 'info' });

function getDropboxClient() {
  const accessToken = process.env.DROPBOX_ACCESS_TOKEN;
  if (!accessToken) {
    console.warn('[dropbox] DROPBOX_ACCESS_TOKEN is not set - session persistence is disabled.');
    return null;
  }
  return new Dropbox({ accessToken, fetch });
}

async function downloadSessionFromDropbox() {
  const dbx = getDropboxClient();
  if (!dbx) return;

  try {
    const response = await dbx.filesDownload({ path: DROPBOX_SESSION_PATH });
    const buffer = response.result.fileBinary;
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    const zip = new AdmZip(buffer);
    zip.extractAllTo(AUTH_FOLDER, true);
    console.log('[dropbox] Restored auth_info session from Dropbox.');
  } catch (err) {
    if (err?.status === 409 || err?.error?.error_summary?.startsWith('path/not_found')) {
      console.log('[dropbox] No existing session found in Dropbox - starting fresh (QR scan required).');
    } else {
      console.error('[dropbox] Failed to download session, starting fresh:', err?.message || err);
    }
  }
}

async function uploadSessionToDropbox() {
  const dbx = getDropboxClient();
  if (!dbx) return;

  try {
    if (!fs.existsSync(AUTH_FOLDER)) return;
    const zip = new AdmZip();
    zip.addLocalFolder(AUTH_FOLDER);
    const buffer = zip.toBuffer();
    await dbx.filesUpload({
      path: DROPBOX_SESSION_PATH,
      contents: buffer,
      mode: { '.tag': 'overwrite' },
    });
    console.log('[dropbox] Uploaded latest auth_info session to Dropbox.');
  } catch (err) {
    console.error('[dropbox] Failed to upload session:', err?.message || err);
  }
}

function extractText(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

async function forwardToN8n(payload) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) {
    console.error('[n8n] N8N_WEBHOOK_URL is not set - dropping message.');
    return;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[n8n] Webhook returned ${res.status}:`, await res.text());
    } else {
      console.log('[n8n] Forwarded pinned message:', payload.text);
    }
  } catch (err) {
    console.error('[n8n] Failed to reach webhook:', err?.message || err);
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await uploadSessionToDropbox();
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n=== Scan this QR code with WhatsApp (Linked Devices) ===\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\n==========================================================\n');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[whatsapp] Connection closed (status ${statusCode}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        connectToWhatsApp();
      } else {
        console.log('[whatsapp] Logged out. Delete the session in Dropbox and redeploy to scan a fresh QR code.');
      }
    } else if (connection === 'open') {
      console.log('[whatsapp] Connected.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.remoteJid !== TARGET_JID) continue;
        if (!msg.key.fromMe) continue;

        const text = extractText(msg.message);
        if (!text || !PIN_EMOJI_REGEX.test(text)) continue;

        const cleanText = text.replace(PIN_EMOJI_REGEX_GLOBAL, '').trim();
        if (!cleanText) continue;

        await forwardToN8n({
          from: msg.key.remoteJid,
          text: cleanText,
          timestamp: Number(msg.messageTimestamp) * 1000,
        });
      } catch (err) {
        console.error('[whatsapp] Error handling message:', err?.message || err);
      }
    }
  });

  return sock;
}

(async () => {
  await downloadSessionFromDropbox();
  await connectToWhatsApp();
})();
