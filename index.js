require('dotenv').config();

// ---------------------------------------------------------------------------
// libsignal (a Baileys dependency) logs raw Signal session objects - including
// private key / root key / chain key buffers - straight to console.info/warn
// (see libsignal/src/session_record.js). Redact those specific lines so secret
// key material never lands in Railway's log stream. Everything else passes
// through untouched.
// ---------------------------------------------------------------------------
const SIGNAL_SECRET_LOG_PREFIXES = [
  'Closing session:',
  'Opening session:',
  'Session already closed',
  'Removing old closed session:',
];
for (const level of ['info', 'warn']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === 'string' && SIGNAL_SECRET_LOG_PREFIXES.some((p) => args[0].startsWith(p))) {
      original(`[signal] ${args[0].replace(/:.*$/, '')} (session details redacted)`);
      return;
    }
    original(...args);
  };
}

const path = require('path');
const fs = require('fs');
const P = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const AdmZip = require('adm-zip');
const { Dropbox } = require('dropbox');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser,
} = require('baileys');

const AUTH_FOLDER = path.join(__dirname, 'auth_info');

function normalizeDropboxPath(rawPath) {
  const trimmed = rawPath.trim();
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
}

const DROPBOX_SESSION_PATH = normalizeDropboxPath(process.env.DROPBOX_SESSION_PATH || '/whatsapp-obsidian/auth_info.zip');
const DROPBOX_QR_PATH = normalizeDropboxPath(process.env.DROPBOX_QR_PATH || '/whatsapp-qr.png');
const SESSION_UPLOAD_DEBOUNCE_MS = Number(process.env.SESSION_UPLOAD_DEBOUNCE_MS || 3000);

const logger = P({ level: process.env.LOG_LEVEL || 'info' });

function logDropboxError(context, err) {
  const status = err?.status;
  const body = err?.error;
  const serializedBody = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  console.error(`[dropbox] ${context} failed (status ${status}):`, serializedBody || err?.message || err);
}

function serializeForLog(value) {
  try {
    return JSON.stringify(value, (key, val) => {
      if (val instanceof Error) {
        return { message: val.message, stack: val.stack, ...val };
      }
      return val;
    }, 2);
  } catch (err) {
    return `[unserializable update: ${err.message}]`;
  }
}

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
  if (!dbx) {
    console.log('[dropbox] Skipping session restore - no DROPBOX_ACCESS_TOKEN configured.');
    return;
  }

  console.log(`[dropbox] Attempting to restore session from ${DROPBOX_SESSION_PATH} ...`);

  try {
    const response = await dbx.filesDownload({ path: DROPBOX_SESSION_PATH });
    const buffer = response.result.fileBinary;

    // Clear any stale/partial local session before extracting, so leftover
    // files from a previous crashed run can't corrupt the restored session.
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    const zip = new AdmZip(buffer);
    zip.extractAllTo(AUTH_FOLDER, true);

    const extractedFiles = fs.readdirSync(AUTH_FOLDER);
    console.log(`[dropbox] Session download succeeded. Extracted ${extractedFiles.length} file(s) into ${AUTH_FOLDER}: ${extractedFiles.join(', ') || '(none)'}`);
  } catch (err) {
    if (err?.status === 409 || err?.error?.error_summary?.startsWith('path/not_found')) {
      console.log('[dropbox] Session download found no existing file in Dropbox - starting fresh (QR scan required).');
    } else {
      console.error('[dropbox] Session download failed with an unexpected error - starting fresh (QR scan required).');
      logDropboxError('Session download', err);
    }
  }
}

async function uploadSessionToDropbox(reason = 'manual') {
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
    console.log(`[dropbox] Uploaded auth_info session to Dropbox (${reason}, ${buffer.length} bytes).`);
  } catch (err) {
    logDropboxError('Session upload', err);
  }
}

// ---------------------------------------------------------------------------
// Session upload scheduling.
//
// Baileys only fires 'creds.update' at login/pairing/key-rotation moments,
// but the Signal key store (sessions, prekeys, sender keys) is written via
// state.keys.set() on virtually EVERY message sent or received. If those
// writes aren't persisted, a container restart restores a stale snapshot and
// the phone's messages no longer decrypt ("Invalid PreKey ID" /
// "No session record"). So every key-store write schedules a debounced
// upload, and uploads are serialized so two zips never race each other.
// ---------------------------------------------------------------------------
let sessionUploadTimer = null;
let sessionUploadRunning = false;
let sessionUploadQueued = false;

function scheduleSessionUpload(reason) {
  if (sessionUploadTimer) clearTimeout(sessionUploadTimer);
  sessionUploadTimer = setTimeout(() => {
    sessionUploadTimer = null;
    runSessionUpload(reason).catch((err) => {
      console.error('[dropbox] Scheduled session upload threw unexpectedly:', err?.stack || err);
    });
  }, SESSION_UPLOAD_DEBOUNCE_MS);
}

async function runSessionUpload(reason) {
  if (sessionUploadRunning) {
    sessionUploadQueued = true;
    return;
  }
  sessionUploadRunning = true;
  try {
    await uploadSessionToDropbox(reason);
  } finally {
    sessionUploadRunning = false;
    if (sessionUploadQueued) {
      sessionUploadQueued = false;
      scheduleSessionUpload('follow-up after concurrent write');
    }
  }
}

async function uploadQrToDropbox(qr) {
  const dbx = getDropboxClient();
  if (!dbx) return;

  try {
    const buffer = await qrcode.toBuffer(qr, { type: 'png' });
    if (!buffer || buffer.length === 0) {
      console.error('[dropbox] Generated QR PNG buffer is empty - skipping upload.');
      return;
    }

    await dbx.filesUpload({
      path: DROPBOX_QR_PATH,
      contents: buffer,
      mode: { '.tag': 'overwrite' },
    });
    console.log(`[dropbox] QR uploaded to Dropbox at ${DROPBOX_QR_PATH} - open Dropbox app on your phone to scan it.`);
  } catch (err) {
    logDropboxError('QR upload', err);
  }
}

// Unwrap container message types (disappearing messages, view-once, document
// captions) so a self-note still extracts even when WhatsApp nests it.
function unwrapMessage(message) {
  return (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.documentWithCaptionMessage?.message ||
    message ||
    null
  );
}

function extractText(message) {
  const m = unwrapMessage(message);
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    null
  );
}

function toMillis(messageTimestamp) {
  const raw = messageTimestamp;
  const seconds = typeof raw === 'number' ? raw : Number(raw?.toNumber ? raw.toNumber() : raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now();
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
      console.log('[n8n] Forwarded message:', payload.text);
    }
  } catch (err) {
    console.error('[n8n] Failed to reach webhook:', err?.message || err);
  }
}

// Your account has two identities: the phone JID (971...@s.whatsapp.net) and
// the anonymized LID (...@lid). Self-chat messages can arrive under EITHER,
// so match against both or notes silently get dropped.
function getSelfJids(sock) {
  const jids = new Set();
  if (sock.user?.id) jids.add(jidNormalizedUser(sock.user.id));
  if (sock.user?.lid) jids.add(jidNormalizedUser(sock.user.lid));
  jids.delete('');
  return jids;
}

// Baileys can deliver the same message more than once (retries, receipts);
// remember recent IDs so a note is never forwarded to n8n twice.
const forwardedMessageIds = new Set();
const FORWARDED_IDS_MAX = 500;

function alreadyForwarded(messageId) {
  if (!messageId) return false;
  if (forwardedMessageIds.has(messageId)) return true;
  forwardedMessageIds.add(messageId);
  if (forwardedMessageIds.size > FORWARDED_IDS_MAX) {
    forwardedMessageIds.delete(forwardedMessageIds.values().next().value);
  }
  return false;
}

// Guards against two Baileys sockets running concurrently on the same
// auth_info (e.g. a duplicate 'close' event firing a second reconnect
// before the first one has finished tearing down). Only ever cleared once
// the active socket actually reaches a terminal 'close' state.
let isSocketActive = false;

async function connectToWhatsApp() {
  if (isSocketActive) {
    console.warn('[whatsapp] connectToWhatsApp() called while a socket is already active - ignoring duplicate call.');
    return;
  }
  isSocketActive = true;

  let sock;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    // Persist Signal key-store writes too, not just creds.json - see the
    // session upload scheduling comment above. Must wrap BEFORE the socket
    // is created so Baileys uses the wrapped setter.
    const originalKeysSet = state.keys.set.bind(state.keys);
    state.keys.set = async (data) => {
      await originalKeysSet(data);
      scheduleSessionUpload('signal key-store write');
    };

    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
    });

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        scheduleSessionUpload('creds update');
      } catch (err) {
        console.error('[whatsapp] Failed to persist credentials update:', err?.stack || err);
      }
    });
  } catch (err) {
    isSocketActive = false;
    console.error('[whatsapp] Failed to initialize WhatsApp socket:', err?.stack || err);
    throw err;
  }

  // Guards against Baileys emitting more than one 'close' event for the
  // same socket instance, which would otherwise trigger multiple parallel
  // reconnects fighting over the same session.
  let closedHandled = false;

  sock.ev.on('connection.update', (update) => {
    console.log('[whatsapp] connection.update:', serializeForLog(update));

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n=== Scan this QR code with WhatsApp (Linked Devices) ===\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\n==========================================================\n');
      uploadQrToDropbox(qr).catch((err) => {
        console.error('[dropbox] QR upload threw unexpectedly:', err?.stack || err);
      });
    }

    if (connection === 'close') {
      if (closedHandled) {
        console.warn('[whatsapp] Duplicate close event for an already-closed socket - ignoring.');
        return;
      }
      closedHandled = true;
      isSocketActive = false;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[whatsapp] Connection closed - statusCode=${statusCode} reason="${errorMessage}" reconnect=${shouldReconnect}`);

      if (shouldReconnect) {
        connectToWhatsApp().catch((err) => {
          console.error('[whatsapp] Reconnect attempt failed:', err?.stack || err);
        });
      } else {
        console.log('[whatsapp] Logged out. Delete the session in Dropbox and redeploy to scan a fresh QR code.');
      }
    } else if (connection === 'open') {
      const selfJids = [...getSelfJids(sock)].join(', ');
      console.log(`[whatsapp] Connected. Watching self-chat for JIDs: ${selfJids || '(unknown yet)'}`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const selfJids = getSelfJids(sock);

    for (const msg of messages) {
      try {
        if (!msg.message) continue;

        // "Message Yourself": fromMe with the chat JID being one of your own
        // identities (phone JID or LID).
        const chatJid = jidNormalizedUser(msg.key.remoteJid || '');
        const isSelfChat = msg.key.fromMe && selfJids.has(chatJid);
        if (!isSelfChat) continue;

        const text = extractText(msg.message);
        if (!text) continue;

        const cleanText = text.trim();
        if (!cleanText) continue;

        if (alreadyForwarded(msg.key.id)) {
          console.log(`[whatsapp] Skipping duplicate delivery of message ${msg.key.id}`);
          continue;
        }

        console.log(`📥 Captured self-note: ${cleanText}`);

        await forwardToN8n({
          from: msg.key.remoteJid,
          text: cleanText,
          timestamp: toMillis(msg.messageTimestamp),
        });
      } catch (err) {
        console.error('[whatsapp] Error handling message:', err?.message || err);
      }
    }
  });

  return sock;
}

// Railway sends SIGTERM on redeploy/stop. Flush the latest session to Dropbox
// before exiting so the next container restores up-to-date Signal keys and
// incoming messages keep decrypting.
let shuttingDown = false;
async function flushSessionAndExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] Received ${signal} - flushing session to Dropbox before exit...`);
  if (sessionUploadTimer) {
    clearTimeout(sessionUploadTimer);
    sessionUploadTimer = null;
  }
  try {
    await uploadSessionToDropbox(`shutdown flush (${signal})`);
  } catch (err) {
    console.error('[shutdown] Final session upload failed:', err?.stack || err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => { flushSessionAndExit('SIGTERM'); });
process.on('SIGINT', () => { flushSessionAndExit('SIGINT'); });

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled promise rejection:', reason instanceof Error ? (reason.stack || reason.message) : reason);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err?.stack || err);
  process.exit(1);
});

(async () => {
  try {
    await downloadSessionFromDropbox();
    await connectToWhatsApp();
  } catch (err) {
    console.error('[fatal] Failed to start WhatsApp bridge:', err?.stack || err);
    process.exit(1);
  }
})();
