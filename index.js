const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
require("dotenv").config();
const express = require("express");
const cron = require("node-cron");

process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Unhandled Promise Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err);
});

// ===== Yardımcı: JID normalize =====
function normalizeJid(id) {
  if (!id) return null;
  id = id.trim();

  if (id.includes("@")) return id; // zaten tam JID

  const digits = id.replace(/\D/g, "");
  if (!digits) return null;
  return digits + "@c.us";
}

// ===== Config =====
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("HATA: GEMINI_API_KEY eksik!");
  process.exit(1);
}

const RAW_ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID || null; // sevgili
const RAW_MY_PHONE = process.env.MY_PHONE || null;               // sen

const ALLOWED_CHAT_ID = normalizeJid(RAW_ALLOWED_CHAT_ID);
const MY_PHONE = normalizeJid(RAW_MY_PHONE);

console.log("🔧 CONFIG:");
console.log("  RAW_ALLOWED_CHAT_ID:", RAW_ALLOWED_CHAT_ID);
console.log("  NORMALIZED_ALLOWED_CHAT_ID:", ALLOWED_CHAT_ID);
console.log("  RAW_MY_PHONE:", RAW_MY_PHONE);
console.log("  NORMALIZED_MY_PHONE:", MY_PHONE);

// Gemini URL
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

  // Basit fetch timeout helper'ı (çevre uyumluluğu eklenmiş)
  function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const AbortControllerImpl =
        typeof AbortController !== "undefined" ? AbortController : null;
      const controller = AbortControllerImpl ? new AbortControllerImpl() : null;

      const id = setTimeout(() => {
        if (controller && typeof controller.abort === "function") controller.abort();
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const doFetch = async () => {
        let _fetch = typeof fetch !== "undefined" ? fetch : null;
        if (!_fetch) {
          try {
            // Try to require node-fetch dynamically if available
            // eslint-disable-next-line global-require
            const nf = require("node-fetch");
            _fetch = nf;
          } catch (e) {
            clearTimeout(id);
            return reject(new Error("fetch is not available in this environment. Install 'node-fetch' or use a Node version with global fetch."));
          }
        }

        try {
          const res = await _fetch(url, { ...options, signal: controller ? controller.signal : undefined });
          clearTimeout(id);
          resolve(res);
        } catch (err) {
          clearTimeout(id);
          reject(err);
        }
      };

      doFetch();
    });
  }


// ===== Runtime State =====
let clientReady = false;
let currentQR = null;

let loverMode = false;      // sevgiliye romantik
let selfLoverMode = false;  // kendi mesajlarına göre ekstra romantik cevap

let lastCallTime = 0;
let lastSpamWarning = 0;

let detectedMyPhone = null;
let detectedGF = null;

// Panel için mesaj logu
const messagesLog = [];
function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function addLog(entry) {
  messagesLog.push({
    ...entry,
    time: new Date().toLocaleTimeString("tr-TR"),
  });
  if (messagesLog.length > 50) messagesLog.shift();
}

// Güvenli mesaj gönderme helper'ı
async function safeReply(msg, text) {
  if (!msg || !text) return;
  try {
    if (typeof msg.reply === "function") {
      await msg.reply(text);
    } else if (typeof msg.send === "function") {
      await msg.send(text);
    } else {
      console.warn("safeReply: msg nesnesinde reply/send fonksiyonu yok");
    }
  } catch (e) {
    console.error("safeReply hata:", e);
  }
}

// Güvenli olarak chat al
async function safeGetChat(msg) {
  if (!msg || typeof msg.getChat !== "function") return null;
  try {
    return await msg.getChat();
  } catch (e) {
    console.error("safeGetChat hata:", e);
    return null;
  }
}

// Bot mesajlarını tanımak için görünmez işaret
const AI_MARK = "\u200B\u200B\u200B"; // başa eklenince görünmüyor

// ===== WhatsApp Client =====
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("auth_failure", (msg) => {
  console.error("❌ WhatsApp auth_failure:", msg);
});

client.on("change_state", (state) => {
  console.log("ℹ️ WhatsApp state changed:", state);
});

client.on("error", (err) => {
  console.error("❌ WhatsApp client error:", err);
});


// ===== QR =====
client.on("qr", async (qr) => {
  console.log("📱 QR oluştu!");

  try {
    qrcodeTerminal.generate(qr, { small: true });
    currentQR = await QRCode.toDataURL(qr);
  } catch (e) {
    console.error("QR üretim hatası:", e);
  }
});

client.on("ready", () => {
  clientReady = true;
  currentQR = null;
  console.log("✅ WhatsApp hazır! Mesajları bekliyorum...");
});

client.on("disconnected", () => {
  clientReady = false;
  console.log("⚠️ Bağlantı koptu. QR tekrar üretilecek.");
});

// ===== TÜM MESAJLARI LOGLAYAN EVENT (GELEN + GİDEN) =====
client.on("message_create", async (msg) => {
  try {
    const text = (msg.body || "").trim();

    addLog({
      direction: msg.fromMe ? "out" : "in",
      from: msg.from,
      to: msg.to,
      body: text,
    });

    console.log("🧾 [CREATE] =>", {
      from: msg.from,
      to: msg.to,
      fromMe: msg.fromMe,
      body: text,
    });

    // Senin numaranı otomatik tespit
    if (!detectedMyPhone && msg.fromMe && typeof msg.from === "string" && msg.from.endsWith("@c.us")) {
      detectedMyPhone = msg.from;
      console.log("🆔 SENİN NUMARAN TESPİT EDİLDİ:", detectedMyPhone);
    }

    // Sevgilinin numarasını otomatik tespit
    if (
      !msg.fromMe &&
      typeof msg.from === "string" &&
      msg.from.endsWith("@c.us") &&
      (!detectedGF || detectedGF === ALLOWED_CHAT_ID) &&
      msg.from !== detectedMyPhone
    ) {
      detectedGF = msg.from;
      console.log("💘 SEVGİLİN TESPİT EDİLDİ:", detectedGF);
    }

    // ----- BURADA: SENİN ATTIGIN MESAJLARA CEVAP -----
    const gfId = ALLOWED_CHAT_ID || detectedGF;
    const meId = MY_PHONE || detectedMyPhone;

    if (
      msg.fromMe &&
      gfId &&
      msg.to === gfId &&
      selfLoverMode &&
      !text.startsWith(AI_MARK)
    ) {
      try {
        const aiReplyPure = await generateAiReply(text, true);
        if (!aiReplyPure) return;

        const aiReply = AI_MARK + aiReplyPure; // görünmez işaret ekledik

        const chat = await safeGetChat(msg);
        if (chat && typeof chat.sendMessage === "function") {
          await chat.sendMessage(aiReply);
        } else {
          console.warn("CHAT gönderilemedi: chat alınamadı veya sendMessage yok");
        }

        console.log("📤 [SELF MSG AUTO-REPLY] =>", aiReplyPure);
      } catch (err) {
        console.error("❌ SELF AUTO-REPLY HATASI:", err);
      }
    }
  } catch (err) {
    console.error("message_create genel hata:", err);
  }
});

// ===== GELEN MESAJLARA CEVAP VEREN LOJİK =====
client.on("message", async (msg) => {
  try {
    const text = (msg.body || "").trim();
    const from = msg.from;

    console.log("📩 [RECEIVED] =>", {
      from,
      body: text,
      fromMe: msg.fromMe,
    });

    if (!text || text.startsWith("http")) return;

    // Spam
    const now = Date.now();
    if (now - lastCallTime < 8000) {
      if (now - lastSpamWarning > 10000) {
        lastSpamWarning = now;
        await msg.reply("lan çok hızlı mesaj yazma botun ömrü azalıyo 😂");
      }
      return;
    }
    lastCallTime = now;

    // Kim kimdir?
    const gfId = ALLOWED_CHAT_ID || detectedGF;
    const meId = MY_PHONE || detectedMyPhone;

    console.log("🔍 KİMLİK KONTROL:", {
      gfId,
      meId,
      incomingFrom: from,
    });

    let romantic = false;

    if (gfId && from === gfId) {
      // Sevgiliden gelen → loverMode'a göre cevap
      romantic = loverMode;
    } else if (meId && from === meId) {
      // Buraya normalde çok düşmez, ama kalsın
      romantic = selfLoverMode;
    } else {
      console.log("ℹ️ Bu gönderenden cevap verilmiyor:", from);
      return;
    }

// Önce ucuz local cevap dene
let aiReplyPure = getCheapLocalReply(text);

if (!aiReplyPure) {
  // Local cevap yoksa Gemini'ye git
  aiReplyPure = await generateAiReply(text, romantic);
}

if (!aiReplyPure) return;

const aiReply = AI_MARK + aiReplyPure;

await msg.reply(aiReply);
console.log("📤 [GÖNDERİLEN CEVAP] =>", aiReplyPure);


  } catch (err) {
    console.error("❌ MESAJ HATASI:", err);
    try {
      await safeReply(msg, "Bir şey oldu ama düzeltiyorum 😅");
    } catch {}
  }
});

function getCheapLocalReply(text) {
  const t = (text || "").trim().toLowerCase();

  if (!t) return null;

  // Tek emoji / kısa onaylamalar
  if (["ok", "okey", "tamam", "k", "kk"].includes(t)) {
    return "Tamamdır 😊";
  }

  if (["😂", "😅", "🤣"].includes(t)) {
    return "Aynen ben de öyleyim şu an 😂";
  }

  if (t.length <= 2) {
    return "Hımm 👀";
  }

  return null; // Gemini'ye gidecek
}


// ===== AI =====
async function generateAiReply(text, romanticMode) {
  try {
    // Çok uzun mesajları kes → token tüketimini azalt
    const trimmed = (text || "").slice(0, 300);

    const vibe = romanticMode
      ? "Kısa ama sıcak ve samimi, hafif romantik cevaplar ver. En fazla 1–2 cümle olsun."
      : "Kısa, samimi ve doğal cevaplar ver. En fazla 1–2 cümle olsun. Romantik olma.";

    const prompt =
      `${vibe}\n` +
      `Kullanıcının mesajı: "${trimmed}"\n` +
      `Sadece cevabı yaz. Selamlaşmayı ve gereksiz tekrarları uzatma.`;

    const res = await fetchWithTimeout(
      `${GEMINI_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 30,   // 70 → 30 (daha kısa)
            temperature: 0.6,
            topP: 0.8,
            stopSequences: ["\n"], // ilk satırda kessin
          },
        }),
      },
      8000 // 8 saniye timeout
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.error("Gemini Hata:", res.status, bodyText);
      return "Şu an biraz meşgulüm gibi oldu 😅 sonra tekrar dener misin?";
    }

    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      console.error("Gemini JSON parse hatası:", parseErr);
      return "Bir gariplik oldu, tekrar yazsana 🙈";
    }

    const reply =
      data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;

    if (!reply) {
      console.error("Gemini boş cevap döndü:", JSON.stringify(data, null, 2));
      return "Ne diyeceğimi bilemedim şu an 😅";
    }

    return reply;

  } catch (err) {
    console.error("Gemini isteğinde genel hata:", err);
    return "Şu an kafam karıştı biraz, tekrar yazar mısın? 😅";
  }
}


// ===== EXPRESS PANEL =====
const app = express();
const PORT = process.env.PORT || 3000;

// Cache kapatma
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/", (req, res) => {
  let qrHTML = "";

  if (!clientReady) {
    qrHTML = currentQR
      ? `<img src="${currentQR}" width="250"/>`
      : `<p>QR üretiliyor...</p>`;
  }

  const logRows = messagesLog
    .slice()
    .reverse()
    .map(
      (m) => `
      <tr>
        <td>${m.time}</td>
        <td>${m.direction === "out" ? "➡️" : "⬅️"}</td>
        <td><code>${escapeHtml(m.from)}</code></td>
        <td><code>${escapeHtml(m.to || "")}</code></td>
        <td>${escapeHtml(m.body)}</td>
      </tr>
    `
    )
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8"/>
        <title>Bot Paneli</title>
      </head>
      <body style="font-family:Arial;padding:20px">

        <h1>🤖 WhatsApp Bot Paneli</h1>

        <p><b>Durum:</b> ${clientReady ? "ÇALIŞIYOR ✅" : "QR BEKLİYOR ⚠️"}</p>

        <h2>QR Kod</h2>
        ${qrHTML}

        <hr>

        <h2>Sevgili Modu</h2>
        <p>Durum: <b>${loverMode ? "AÇIK 🔥" : "KAPALI ❌"}</b></p>
        <a href="/toggleLover"><button style="padding:10px">Değiştir</button></a>

        <hr>

        <h2>Kendine Romantik Mod (sen yazınca ekstra cevap)</h2>
        <p>Durum: <b>${selfLoverMode ? "AÇIK ❤️" : "KAPALI ❌"}</b></p>
        <a href="/toggleSelf"><button style="padding:10px">Değiştir</button></a>

        <hr>

        <p>Sevgili ID (env): <code>${RAW_ALLOWED_CHAT_ID || "-"}</code></p>
        <p>Sevgili ID (normalize): <code>${ALLOWED_CHAT_ID || "-"}</code></p>
        <p>Sevgili ID (taranan): <code>${detectedGF || "bekleniyor..."}</code></p>

        <p>Senin ID (env): <code>${RAW_MY_PHONE || "-"}</code></p>
        <p>Senin ID (normalize): <code>${MY_PHONE || "-"}</code></p>
        <p>Senin ID (taranan): <code>${detectedMyPhone || "bekleniyor..."}</code></p>

        <hr>

        <h2>Son Mesajlar (in/out hepsi)</h2>
        <table border="1" cellspacing="0" cellpadding="4">
          <thead>
            <tr>
              <th>Saat</th>
              <th>Yön</th>
              <th>From</th>
              <th>To</th>
              <th>Mesaj</th>
            </tr>
          </thead>
          <tbody>
            ${logRows || "<tr><td colspan='5'>Henüz mesaj yok</td></tr>"}
          </tbody>
        </table>

      </body>
    </html>
  `);
});

app.get("/toggleLover", (req, res) => {
  loverMode = !loverMode;
  console.log("⭐ loverMode:", loverMode);
  res.redirect("/");
});

app.get("/toggleSelf", (req, res) => {
  selfLoverMode = !selfLoverMode;
  console.log("⭐ selfLoverMode:", selfLoverMode);
  res.redirect("/");
});

// ===== START =====
// ===== START =====
try {
  client.initialize();
} catch (e) {
  console.error("Client initialize hatası:", e);
}

// Express error middleware (son route'lardan sonra olmalı)
app.use((err, req, res, next) => {
  console.error("🌋 Express error:", err);
  if (res.headersSent) return next(err);
  res.status(500).send("Sunucuda beklenmedik bir hata oldu. Birazdan tekrar dene. 🙈");
});

// Güvenli başlangıç: server referansı tut ve hataları yakala
let server = null;
try {
  server = app.listen(PORT, () => console.log(`🌐 Panel aktif → http://localhost:${PORT}`));
  server.on('error', (err) => {
    console.error('Server hata:', err);
  });
} catch (e) {
  console.error('app.listen hatası:', e);
}

// Graceful shutdown
async function shutdown(code = 0) {
  console.log('⚙️ Kapanış başlatılıyor...');
  try {
    if (client && typeof client.destroy === 'function') {
      try {
        await client.destroy();
        console.log('Client kapatıldı.');
      } catch (e) {
        console.error('Client destroy hatası:', e);
      }
    }
    if (server && typeof server.close === 'function') {
      server.close(() => console.log('HTTP server kapatıldı.'));
    }
  } catch (e) {
    console.error('Kapanış sırasında hata:', e);
  } finally {
    process.exit(code);
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
