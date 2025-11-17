const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
require("dotenv").config();
const express = require("express");
const cron = require("node-cron");

// ===== Ortam değişkenleri =====
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("HATA: GEMINI_API_KEY .env dosyasında tanımlı değil!");
  process.exit(1);
}

const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID || null;

// Gemini endpoint
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

// Cooldowns
let lastCallTime = 0;
let lastSpamWarning = 0;
let clientReady = false;

// ANASAYFADA GÖSTERECEĞİMİZ QR
let currentQR = null;

// ===== WhatsApp Client =====
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

// ===== QR OLUŞUNCA =====
client.on("qr", async (qr) => {
  console.log("📱 QR oluştu — terminal ve anasayfada gösteriliyor.");

  // Terminal QR
  qrcodeTerminal.generate(qr, { small: true });

  // PNG Base64 QR üret
  currentQR = await QRCode.toDataURL(qr);
});

// ===== Hazır =====
client.on("ready", () => {
  clientReady = true;
  currentQR = null; // QR artık gereksiz
  console.log("✅ WhatsApp + Gemini bot hazır, mesaj bekliyorum...");
});

client.on("disconnected", () => {
  clientReady = false;
  console.log("⚠️ WhatsApp bağlantısı koptu, tekrar QR üretilecek.");
});

// ===== Mesaj Dinleme =====
client.on("message", async (msg) => {
  try {
    const text = (msg.body || "").trim();
    console.log("Mesaj geldi:", { from: msg.from, body: text });

    if (ALLOWED_CHAT_ID && msg.from !== ALLOWED_CHAT_ID) return;
    if (!text || text.startsWith("http")) return;

    const now = Date.now();
    const tooFast = now - lastCallTime < 8000;

    // Spam kontrolü
    if (tooFast) {
      if (now - lastSpamWarning > 10000) {
        lastSpamWarning = now;
        await msg.reply("lan çok hızlı mesaj yazma botun ömrü azalıyo 😂");
      }
      return;
    }

    lastCallTime = now;

    const aiReply = await generateAiReply(text);
    if (!aiReply) return;

    await msg.reply(aiReply);
    console.log("Gönderilen cevap:", aiReply);

  } catch (err) {
    console.error("Mesaj işlenirken hata:", err);
  }
});

// Botu başlat
client.initialize();

// ===== Gemini API =====
async function generateAiReply(incomingText) {
  try {
    const prompt =
      "Sen, genç bir erkeğin çok aşık sevgilisiymiş gibi yazan, Türkçe konuşan bir asistansın. " +
      "Mesajların samimi, bol aşk ve sevgi dolu, arada esprili. .\n\n" +
      `Mesaj: "${incomingText}"\n\n` +
      "Sadece cevabı yaz, açıklama ekleme.";

    const res = await fetch(
      `${GEMINI_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 60,
            temperature: 0.7,
          },
        }),
      }
    );

    if (!res.ok) {
      console.error("Gemini HATA:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;

  } catch (err) {
    console.error("Gemini isteğinde hata:", err);
    return null;
  }
}

// ===== EXPRESS ANASAYFA =====
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  let qrHTML = "";

  if (!clientReady && currentQR) {
    qrHTML = `
      <h2>📸 QR Kod (telefonunla tara)</h2>
      <img src="${currentQR}" style="width:250px; image-rendering: pixelated;"/>
    `;
  }

  res.send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <title>WhatsApp Bot Durumu</title>
      </head>
      <body style="font-family: system-ui; padding: 20px;">
        <h1>🤖 WhatsApp Bot</h1>

        <p>Durum: <b>${clientReady ? "ÇALIŞIYOR ✅" : "QR BEKLİYOR ⚠️"}</b></p>

        ${qrHTML}

        <hr>
        <p>Hedef kullanıcı (ALLOWED_CHAT_ID): <code>${ALLOWED_CHAT_ID}</code></p>
        <ul>
          <li>Mesajlara AI ile cevap verir</li>
          <li>Spamde uyarır: “lan çok hızlı mesaj yazma botun ömrü azalıyo 😂”</li>
          <li>08:00 — Günaydın 🌅</li>
          <li>12:00 — İyi öğlenler ☀️</li>
          <li>00:00 — İyi geceler 🌙</li>
        </ul>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🌐 Anasayfa aktif: http://localhost:${PORT}`);
});
