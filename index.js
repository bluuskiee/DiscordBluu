require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST, 
  Routes, 
  ApplicationCommandOptionType, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle, 
  PermissionsBitField 
} = require("discord.js");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

function sendEmbed(channel, description) {
  try {
    const embed = new EmbedBuilder().setDescription(String(description)).setColor(0x00BFFF);
    if (channel && typeof channel.send === 'function') {
      return channel.send({ embeds: [embed] });
    }
  } catch (e) {
    console.error('Failed to send embed:', e);
  }
}

function sendErrorEmbed(channel, description) {
    const errorEmbed = new EmbedBuilder()
        .setColor("#e74c3c") 
        .setTitle("Operasi Dibatalkan")
        .setDescription(`>>> **DETAIL ERROR:**\n${description}`);
    if (channel && typeof channel.send === 'function') {
        return channel.send({ embeds: [errorEmbed] });
    }
}

function sendSuccessEmbed(channel, description, title = "Sukses") {
    const successEmbed = new EmbedBuilder()
        .setColor("#2ecc71") 
        .setTitle(title) 
        .setDescription(`>>> ${description}`);
    if (channel && typeof channel.send === 'function') {
        return channel.send({ embeds: [successEmbed] });
    }
}

function parseDuration(durationStr) {
    const units = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
    };

    const match = durationStr.match(/^(\d+)([smhd])$/i);
    if (!match) return null;

    const [, value, unit] = match;
    const ms = parseInt(value, 10) * units[unit.toLowerCase()];

    const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
    
    return ms > MAX_TIMEOUT_MS ? MAX_TIMEOUT_MS : ms;
}

function getMonthStartSQL() {
    return "DATE('now', 'start of month', 'localtime')";
}

function getLastDaysStartSQL(days) {
    return `DATE('now', '-${parseInt(days)} days', 'localtime')`;
}

const TOKEN = process.env.TOKEN;
const LIVE_CHANNEL_ID = process.env.LIVE_CHANNEL_ID;
const BUY_LOG_CHANNEL_ID = process.env.BUY_LOG_CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;
const QRIS_IMAGE_URL = process.env.QRIS_IMAGE_URL;
const UPDATE_INTERVAL = 10000;
const ALLOWED_ROLES = ["Owner", "Admin"];


const db = new Database(path.join(__dirname, "database.sqlite"));
db.pragma("journal_mode = WAL");
db.prepare(`
CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  code TEXT NOT NULL,
  used INTEGER DEFAULT 0
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  type TEXT,
  qty INTEGER,
  seller_id TEXT, 
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`).run();

try {
    db.prepare(`ALTER TABLE sales ADD COLUMN seller_id TEXT`).run();
    console.log("[DB FIX] Kolom 'seller_id' berhasil ditambahkan ke tabel 'sales'.");
} catch (e) {
    if (!e.message.includes("duplicate column name")) {
        console.warn("[DB WARNING] Gagal menjalankan ALTER TABLE. Kemungkinan kolom sudah ada atau masalah lain:", e.message);
    }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: ["CHANNEL"]
});

function getProductDetails(type) {
  if (type === 'VIP7D') {
    return {
      title: "Redfinger VIP 7 Day Android 12",
      period: "7 Day",
      price: 19300
    };
  } else if (type === 'VIP30D') {
    return {
    title: "Redfinger VIP 30 Day Android 12",
      period: "30 Day",
      price: 61000
    };
  }
  return null;
}

function buildEmbed() {
  const vip7d = db.prepare("SELECT COUNT(*) AS c FROM codes WHERE type='VIP7D' AND used=0").get().c;
  const vip30d = db.prepare("SELECT COUNT(*) AS c FROM codes WHERE type='VIP30D' AND used=0").get().c;

  return new EmbedBuilder()
    .setColor("#2ecc71")
    .setTitle("Stock Real Time")
    .addFields(
      { name: "VIP 7 Day", value: `**Produk:** Redfinger VIP 7 Day Android 12\n**Stock:** ${vip7d.toLocaleString('id-ID')}\n**Price:** Rp19.300`, inline: true },
      { name: "VIP 30 Day", value: `**Produk:** Redfinger VIP 30 Day Android 12\n**Stock:** ${vip30d.toLocaleString('id-ID')}\n**Price:** Rp61.000`, inline: true }
    )
    .setFooter({ text: "Terakhir diperbarui" }) 
    .setTimestamp(); 
}

function hasPermission(member) {
  return member?.roles.cache.some(r => ALLOWED_ROLES.includes(r.name));
}

function fetchAndFormatSales(periodType, days, db) {
    let whereClause = "";
    let title = "Laporan Penjualan";
    let detailPeriod = "Seluruh Waktu";

    if (periodType === 'daily') {
        whereClause = `WHERE DATE(created_at) = DATE('now', 'localtime')`;
        title = "Laporan Penjualan Harian";
        detailPeriod = new Date().toLocaleDateString('id-ID', {day: '2-digit', month: 'long', year: 'numeric'});
    } else if (periodType === 'monthly') {
        whereClause = `WHERE DATE(created_at) >= ${getMonthStartSQL()}`;
        title = "Laporan Penjualan Bulanan";
        detailPeriod = new Date().toLocaleDateString('id-ID', {month: 'long', year: 'numeric'});
    } else if (periodType === 'last') {
         whereClause = `WHERE DATE(created_at) >= ${getLastDaysStartSQL(days)}`;
         title = `Laporan Penjualan ${days} Hari Terakhir`;
         detailPeriod = `${days} Hari Terakhir`;
    } else if (periodType === 'total') {
        whereClause = "";
        title = "Laporan Penjualan Total (All Time)";
        detailPeriod = "Sepanjang Masa";
    }

    const salesSummary = db.prepare(`
        SELECT type, SUM(qty) AS total_qty
        FROM sales
        ${whereClause}
        GROUP BY type
    `).all();

    let totalRevenue = 0;
    let totalQty = 0;

    const details = salesSummary.map(sale => {
        const product = getProductDetails(sale.type);
        const revenue = product ? product.price * sale.total_qty : 0;
        totalRevenue += revenue;
        totalQty += sale.total_qty;
        return {
            type: sale.type,
            qty: sale.total_qty,
            revenue: revenue
        };
    });
    
    return { title, detailPeriod, totalRevenue, totalQty, details };
}

const formatLeaderboard = async (message, data, totalType, isSeller) => {
    let description = "";
    
    for (const [index, entry] of data.entries()) { 
        const rank = index + 1;
        let userDisplay;
        const total = entry[totalType];

        try {
            const member = await message.guild.members.fetch(entry.user_id).catch(() => null);
            
            if (member) {
                userDisplay = member.user.tag; 
            } else {
                const user = await client.users.fetch(entry.user_id).catch(() => null);
                if (user) {
                    userDisplay = user.tag;
                } else {
                    userDisplay = `[ID: ${entry.user_id}] (User Tidak Ditemukan)`; 
                }
            }
        } catch (e) {
            console.error(`Gagal fetch user ID ${entry.user_id}:`, e);
            userDisplay = `[ID: ${entry.user_id}] (Error)`; 
        }
        if (isSeller && userDisplay.startsWith('[')) {
             description += `**#${rank}.** ${userDisplay} - **${total.toLocaleString('id-ID')}** Kode\n`;
        } else if (isSeller) {
             description += `**#${rank}.** <@${entry.user_id}> (${userDisplay}) - **${total.toLocaleString('id-ID')}** Kode\n`;
        } else {
             description += `**#${rank}.** ${userDisplay} - **${total.toLocaleString('id-ID')}** Kode\n`;
        }
    } 
    return description;
};

async function registerSlashCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    let clientId;

    try {
        const user = await client.users.fetch(client.user.id);
        clientId = user.id;
    } catch (e) {
        console.error("Gagal mendapatkan client ID:", e);
        return;
    }

    try {
        console.log('Mulai MENGHAPUS application (/) commands.');
        await rest.put(
            Routes.applicationGuildCommands(clientId, GUILD_ID),
            { body: [] },
        );
        console.log('Berhasil MENGHAPUS application (/) commands di Guild ID:', GUILD_ID);
    } catch (error) {
        console.error('Gagal menghapus commands:', error);
    }
}

client.once("ready", async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);
  
  await registerSlashCommands(); 

  const channel = await client.channels.fetch(LIVE_CHANNEL_ID);
  if (!channel) return console.error("Channel LIVE_CHANNEL_ID tidak ditemukan.");

  let liveMessage;
  
  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    
    const botMessages = messages.filter(
        m => m.author.id === client.user.id && 
             m.embeds.length > 0 && 
             (m.embeds[0].title === 'Live Stock' || m.embeds[0].title === 'INFORMASI STOK REAL-TIME' || m.embeds[0].title === 'Stock Real Time')
    );
    
    if (botMessages.size > 0) {
      liveMessage = botMessages.first(); 
      console.log('Pesan Live Stock yang ada akan di-update.');
    } else {
      liveMessage = await channel.send({ embeds: [buildEmbed()] });
      console.log('Pesan Live Stock baru telah dikirim.');
    }
  } catch (e) {
      console.error("Gagal mencari pesan Live Stock yang ada, mengirim pesan baru (Fallback):", e);
      liveMessage = await channel.send({ embeds: [buildEmbed()] });
  }

  setInterval(async () => {
    try {
      await liveMessage.edit({ embeds: [buildEmbed()] });
    } catch (e) {
        if (e.code === 10008) { 
            console.log('Pesan Live Stock telah dihapus. Mengirim pesan baru.');
            const newLiveMessage = await channel.send({ embeds: [buildEmbed()] });
            liveMessage = newLiveMessage;
        } else {
            console.error("Gagal update embed:", e);
        }
    }
  }, UPDATE_INTERVAL);
});

async function queryUnusedCodes(type) {
  try {
    const rows = db
      .prepare("SELECT code FROM codes WHERE type=? AND used=0")
      .all(type);
    return rows.map((r) => r.code);
  } catch (e) {
    console.error("DB query error:", e);
    return [];
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content) return;
    
  const content = message.content.trim();
  const args = content.split(/\s+/);
  const cmd = args[0]?.toLowerCase();

  let member = null;
  if (message.guild) {
    member = await message.guild.members.fetch(message.author.id).catch(() => null);
  }
  
  const adminCmds = ["!send", "!sendsalebulk", "!addcode", "!import", "!check", "!log", "!addrole", "!mute", "!unmute", "!sales", "!view", "!embed", "!leaderboard", "!lb"]; 
  
  if (adminCmds.includes(cmd) && (!member || !hasPermission(member))) {
      const isViewCode = cmd === '!view' && args[1]?.toLowerCase() === 'code';
      if (!isViewCode && cmd !== "!view") { 
          return sendErrorEmbed(message.channel, "Kamu tidak punya izin untuk menggunakan command ini.");
      }
  }

  if (cmd === "!send") {
    if (args.length < 4)
      return sendErrorEmbed(message.channel, "Format salah. Gunakan: `!send 7d/30d <jumlah> @pembeli`");

    const type = args[1] === "7d" ? "VIP7D" : args[1] === "30d" ? "VIP30D" : null;
    const qty = parseInt(args[2], 10);
    const mention = message.mentions.users.first();
    const product = getProductDetails(type);

    if (!type) return sendErrorEmbed(message.channel, "Jenis harus 7d atau 30d.");
    if (isNaN(qty) || qty <= 0) return sendErrorEmbed(message.channel, "Jumlah harus angka positif.");
    if (!mention) return sendErrorEmbed(message.channel, "Tag pembeli dengan format: `!send 7d 2 @pembeli`");
    if (!product) return sendErrorEmbed(message.channel, "Tipe produk tidak valid.");

    const available = db.prepare("SELECT * FROM codes WHERE type=? AND used=0 LIMIT ?").all(type, qty);
    if (available.length < qty)
      return sendErrorEmbed(message.channel, `Stok tidak cukup. Tersedia: ${available.length}`);

    const codesText = available.map(c => c.code).join("\n");
    const filename = `${type}_${Date.now()}.txt`;
    const filepath = path.join(__dirname, filename);
    fs.writeFileSync(filepath, codesText, "utf8");
    let attachment = new AttachmentBuilder(filepath);

    let dmSuccess = false;
    try {
      await mention.send({
        content: `Pembelian ${qty} kode untuk **${type}** telah Berhasil`,     
        files: [attachment]
      });
      
      const markUsed = db.prepare("UPDATE codes SET used=1 WHERE id=?");
      for (const c of available) markUsed.run(c.id);

      db.prepare("INSERT INTO sales (user_id, type, qty, seller_id) VALUES (?, ?, ?, ?)").run(mention.id, type, qty, message.author.id);

      sendSuccessEmbed(
        message.channel, 
        `Berhasil mengirim ${qty} kode ${type} ke **${mention.tag}**.\n\nJangan lupa untuk mengisi Testimoni Buyer di [Channel Testimoni](https://discord.com/channels/1433146730987389193/1433146732534960244). Terima kasih!`, 
        "Transaksi Berhasil Dicatat"
      );
      dmSuccess = true;
    } catch (e) {
        console.error(`Gagal kirim DM ke ${mention.tag}:`, e);
        
        sendErrorEmbed(message.channel, 
            `Gagal kirim DM ke **${mention.tag}** DM pengguna mungkin tertutup, Mohon untuk buka Privasi Direct Message anda`
        );
        
    } finally {
    
        fs.unlinkSync(filepath);
    }
    
    if (dmSuccess) {
        const logChannel = await message.client.channels.fetch(BUY_LOG_CHANNEL_ID);

        if (logChannel) {
            const totalPrice = product.price * qty;
            const historyEmbed = new EmbedBuilder()
                .setColor("#2ecc71")
                .setTitle(`Redfinger VIP ${product.period}`)
                .setDescription(`Terimakasih ${mention.tag} telah membeli ${type} di **${message.guild.name}**`)
                .addFields(
                    { name: "Pembelian", value: `${qty} Kode`, inline: true },
                    { name: "Harga Satuan", value: `Rp${product.price.toLocaleString('id-ID')}`, inline: true },
                    { name: "Harga Total", value: `**Rp${totalPrice.toLocaleString('id-ID')}**`, inline: true }
                )
                .setThumbnail(mention.displayAvatarURL({ dynamic: true, size: 256 })) 
                .setFooter({ 
                    text: `Transaksi berhasil oleh ${message.author.tag}`, 
                })
                .setTimestamp();

            try {
                await logChannel.send({ embeds: [historyEmbed] });
            } catch (e) {
                console.error("Gagal mengirim embed riwayat pembelian ke Buy Log Channel:", e);
            }
        } else {
            console.error("Buy Log Channel tidak ditemukan. ID:", BUY_LOG_CHANNEL_ID);
        }
    }
  }

  else if (cmd === "!addcode") {
    if (args.length < 3)
      return sendErrorEmbed(message.channel, "Format salah. Gunakan: `!addcode 7d <kode>` atau `!addcode 30d <kode>`");

    const type = args[1] === "7d" ? "VIP7D" : args[1] === "30d" ? "VIP30D" : null;
    if (!type)
      return sendErrorEmbed(message.channel, " Jenis harus 7d atau 30d.");

    const code = args.slice(2).join(" ");
    db.prepare("INSERT INTO codes (type, code) VALUES (?, ?)").run(type, code);
    sendSuccessEmbed(message.channel, `Kode baru untuk **${type}** berhasil ditambahkan ke database.`, "Stok Diperbarui");
  }

  else if (cmd === "!import") {
    if (args.length < 2)
      return sendErrorEmbed(message.channel, "Format salah. Gunakan: `!import 7d` lalu upload file .txt");

    const type = args[1] === "7d" ? "VIP7D" : args[1] === "30d" ? "VIP30D" : null;
    if (!type)
      return sendErrorEmbed(message.channel, "Jenis harus 7d atau 30d.");

    if (message.attachments.size === 0)
      return sendErrorEmbed(message.channel, "Mohon upload file `.txt` yang berisi kode (satu per baris).");

    const file = message.attachments.first();
    const res = await fetch(file.url);
    const text = await res.text();
    const codes = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    const insert = db.prepare("INSERT INTO codes (type, code) VALUES (?, ?)");
    const tx = db.transaction((arr) => {
      for (const c of arr) insert.run(type, c);
    });
    tx(codes);

    sendSuccessEmbed(message.channel, `Berhasil mengimpor **${codes.length} kode** untuk **${type}** ke database.`, "Stok Massal Ditambahkan");
  }

  // --- COMMAND !qris ---
  else if (cmd === "!qris") {
    const qrisEmbed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Pembayaran QRIS Redfinger Bluu Store")
      .setDescription("Silakan scan kode QRIS di bawah ini untuk menyelesaikan pembayaran Anda. **Pastikan jumlah transfer sudah sesuai.**")
      .setImage(QRIS_IMAGE_URL) 
      .setFooter({ text: "Terima kasih atas transaksi Anda!" })
      .setTimestamp();
      
    try {
        await message.channel.send({ embeds: [qrisEmbed] });
    } catch (e) {
        console.error("Gagal mengirim embed QRIS:", e);
        sendErrorEmbed(message.channel, "Gagal mengirim informasi QRIS. Silakan hubungi admin.");
    }
  }

  // --- COMMAND !addrole ---
  else if (cmd === "!addrole") {
    if (args.length < 3)
      return sendErrorEmbed(message.channel, "Format salah. Gunakan: `!addrole @user @role`");

    const targetUser = message.mentions.members.first();
    const roleMention = message.mentions.roles.first();
    let targetRole = null;
    
    if (roleMention) {
        targetRole = roleMention;
    } else if (args[2]) {
        const roleNameOrId = args.slice(2).join(" ");
        targetRole = message.guild.roles.cache.find(
            role => role.name.toLowerCase() === roleNameOrId.toLowerCase() || role.id === roleNameOrId
        );
    }
    if (!targetUser)
      return sendErrorEmbed(message.channel, "Tag pengguna yang ingin diberikan role: `!addrole @user @role`");
    if (!targetRole)
      return sendErrorEmbed(message.channel, "Role tidak ditemukan. Pastikan kamu men-tag role atau menulis nama/ID role dengan benar.");

    try {
      await targetUser.roles.add(targetRole);
      sendSuccessEmbed(message.channel, `Berhasil memberikan role **${targetRole.name}** kepada ${targetUser.user.tag}.`, "Role Diberikan");
    } catch (error) {
      console.error(`Gagal memberikan role: ${error}`);
      sendErrorEmbed(message.channel, `Gagal memberikan role **${targetRole.name}** kepada ${targetUser.user.tag}. Pastikan role bot lebih tinggi dari role yang ingin diberikan.`);
    }
  }

  // --- COMMAND !mute ---
  else if (cmd === "!mute") {
    if (args.length < 3)
      return sendErrorEmbed(message.channel, "Format salah. Gunakan: `!mute @user <duration> [reason]`. Contoh durasi: `5m`, `2h`, `1d`");

    const targetUser = message.mentions.members.first();
    const durationStr = args[2];
    const reason = args.slice(3).join(" ") || "Tidak ada alasan spesifik";
    if (!targetUser)
      return sendErrorEmbed(message.channel, "Tag pengguna yang ingin di-mute.");

    const durationMs = parseDuration(durationStr);
    if (durationMs === null)
      return sendErrorEmbed(message.channel, "Format durasi tidak valid. Gunakan format: `5s`, `10m`, `2h`, `1d`.");
    if (targetUser.roles.highest.position >= message.guild.members.me.roles.highest.position) {
        return sendErrorEmbed(message.channel, "Saya tidak bisa mem-mute pengguna ini karena role saya lebih tinggi atau sama dengan target.");
    }

    try {
      await targetUser.timeout(durationMs, reason);
      sendSuccessEmbed(message.channel, `Berhasil memberikan Timeout kepada **${targetUser.user.tag}** selama **${durationStr}**.\nAlasan: *${reason}*`, "Timeout Diberikan");
    } catch (error) {
      console.error(`Gagal memberikan Timeout: ${error}`);
      sendErrorEmbed(message.channel, `Gagal memberikan Timeout. Mungkin pengguna tersebut adalah Admin atau role bot terlalu rendah.`);
    }
  }

  // --- COMMAND !unmute ---
  else if (cmd === "!unmute") {
    if (args.length < 2)
      return sendErrorEmbed(message.channel, "Format salah. Gunakan: `!unmute @user`");

    const targetUser = message.mentions.members.first();
    if (!targetUser)
      return sendErrorEmbed(message.channel, "Tag pengguna yang ingin di-unmute.");
    if (targetUser.roles.highest.position >= message.guild.members.me.roles.highest.position) {
        return sendErrorEmbed(message.channel, "Saya tidak bisa memodifikasi pengguna ini karena role saya lebih tinggi atau sama dengan target.");
    }
    if (!targetUser.communicationDisabledUntil) {
        return sendErrorEmbed(message.channel, `**${targetUser.user.tag}** saat ini tidak dalam mode Timeout.`);
    }

    try {
      await targetUser.timeout(null, "Unmute oleh Admin");
      sendSuccessEmbed(message.channel, `Berhasil menghapus Timeout (unmute) untuk **${targetUser.user.tag}**.`);
    } catch (error) {
      console.error(`Gagal menghapus Timeout: ${error}`);
      sendErrorEmbed(message.channel, `Gagal menghapus Timeout. Mungkin ada masalah izin lain.`);
    }
  }

  // --- COMMAND !price ---
  else if (cmd === "!price") {
    if (args.length < 3)
      return sendErrorEmbed(message.channel, "Format salah. Gunakan: `!price 7d <jumlah>` atau `!price 30d <jumlah>`");

    const type = args[1] === "7d" ? "VIP7D" : args[1] === "30d" ? "VIP30D" : null;
    const qty = parseInt(args[2], 10);
    const product = getProductDetails(type);

    if (!type) return sendErrorEmbed(message.channel, "Jenis harus `7d` atau `30d`.");
    if (isNaN(qty) || qty <= 0) return sendErrorEmbed(message.channel, "Jumlah harus angka positif.");
    if (!product) return sendErrorEmbed(message.channel, "Tipe produk tidak valid.");

    const totalPrice = product.price * qty;

    const priceEmbed = new EmbedBuilder()
        .setColor("#3498db")
        .setTitle("Estimasi Biaya Pembelian")
        .setDescription(`Rincian perkiraan biaya untuk pembelian **${qty} kode ${type}** saat ini.`)
        .addFields(
            { name: "Produk", value: product.title, inline: false },
            { name: "Harga Satuan", value: `Rp${product.price.toLocaleString('id-ID')}`, inline: true },
            { name: "Jumlah Beli", value: `${qty} Kode`, inline: true },
            { name: "Total Biaya", value: `**Rp${totalPrice.toLocaleString('id-ID')}**`, inline: false }
        )
        .setFooter({ text: "Harga belum termasuk diskon grosir. Gunakan command !qris untuk melakukan pembayaran." })
        .setTimestamp();
        
    message.channel.send({ embeds: [priceEmbed] });
  }

  // --- COMMAND !sales ---
  else if (cmd === "!sales") {
    if (args.length < 2) {
        return sendErrorEmbed(message.channel, "Format salah. Gunakan: `!sales daily`, `!sales monthly`, `!sales total`, atau `!sales last <hari>`");
    }

    const salesType = args[1].toLowerCase();
    let reportData = null;
    let days = args[2] ? parseInt(args[2], 10) : null;

    if (salesType === 'daily') {
        reportData = fetchAndFormatSales('daily', null, db);
    } else if (salesType === 'monthly') {
        reportData = fetchAndFormatSales('monthly', null, db);
    } else if (salesType === 'total') {
        reportData = fetchAndFormatSales('total', null, db);
    } else if (salesType === 'last' && days && !isNaN(days) && days > 0) {
        reportData = fetchAndFormatSales('last', days, db);
    } else {
        return sendErrorEmbed(message.channel, "Jenis laporan tidak valid. Gunakan: `daily`, `monthly`, `total`, atau `last <hari>`.");
    }

    if (!reportData) {
        return sendErrorEmbed(message.channel, "Gagal memproses permintaan laporan.");
    }
    
    const { title, detailPeriod, totalRevenue, totalQty, details } = reportData;

    if (totalQty === 0) {
        return sendEmbed(message.channel, `Belum ada transaksi penjualan yang tercatat pada periode **${detailPeriod}**.`);
    }

    const revenue7d = details.find(d => d.type === 'VIP7D')?.revenue || 0;
    const qty7d = details.find(d => d.type === 'VIP7D')?.qty || 0;
    const revenue30d = details.find(d => d.type === 'VIP30D')?.revenue || 0;
    const qty30d = details.find(d => d.type === 'VIP30D')?.qty || 0;
    
    const embed = new EmbedBuilder()
        .setColor("#e74c3c")
        .setTitle(title)
        .setDescription(`Ringkasan performa penjualan pada periode **${detailPeriod}**.`)
        .addFields(
            { name: "Total Semua Penjualan", value: `**${totalQty.toLocaleString('id-ID')}** Kode`, inline: true },
            { name: "Total Pendapatan", value: `**Rp${totalRevenue.toLocaleString('id-ID')}**`, inline: true },
            { name: "\u200b", value: "\u200b", inline: false },

            { name: "VIP 7 Day", value: `Qty: ${qty7d.toLocaleString('id-ID')} | Pendapatan: Rp${revenue7d.toLocaleString('id-ID')}`, inline: true },
            { name: "VIP 30 Day", value: `Qty: ${qty30d.toLocaleString('id-ID')} | Pendapatan: Rp${revenue30d.toLocaleString('id-ID')}`, inline: true }
        )
        .setFooter({ text: `Laporan dihasilkan oleh ${message.author.tag}` })
        .setTimestamp();

    message.channel.send({ embeds: [embed] });
  }
  
  // --- COMMAND !leaderboard / !lb ---
  else if (cmd === "!leaderboard" || cmd === "!lb") { 
    if (args.length < 2) {
        return sendErrorEmbed(message.channel, "Format salah. Gunakan: `!leaderboard buyer` atau `!leaderboard seller` (atau `!lb`).");
    }

    const type = args[1].toLowerCase();
    let query, title, idColumn, totalAlias;
    let color = 0x0099ff;
    let isSeller = false;

    if (type === 'buyer') {
        idColumn = 'user_id';
        totalAlias = 'total_bought';
        title = "👑 Top 10 Pembeli (Berdasarkan Total Kuantitas Dibeli)";
        color = 0x2ecc71;
    } else if (type === 'seller') {
        if (!member || !hasPermission(member)) {
            return sendErrorEmbed(message.channel, "Kamu tidak punya izin untuk melihat Leaderboard Seller.");
        }
        idColumn = 'user_id';
        totalAlias = 'total_sold';
        title = "🏅 Top 10 Penjual (Berdasarkan Total Kuantitas Terjual)";
        color = 0xf1c40f;
        isSeller = true; // Set flag seller
    } else {
        return sendErrorEmbed(message.channel, "Jenis Leaderboard tidak valid. Gunakan: `!leaderboard buyer` atau `!leaderboard seller`.");
    }

    query = `
        SELECT 
            ${idColumn} AS user_id, 
            SUM(qty) as ${totalAlias}
        FROM sales
        GROUP BY ${idColumn}
        ORDER BY ${totalAlias} DESC
        LIMIT 10
    `;

    const leaderboardData = db.prepare(query).all();

    if (leaderboardData.length === 0) {
        return sendEmbed(message.channel, `Belum ada data penjualan yang tercatat untuk menghitung Leaderboard ${type}.`);
    }

    // Panggilan fungsi formatLeaderboard dengan argumen 'message'
    const leaderboardDescription = await formatLeaderboard(message, leaderboardData, totalAlias, isSeller);

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(leaderboardDescription)
        .setColor(color)
        .setFooter({ text: `Diperbarui pada` })
        .setTimestamp();

    try {
        await message.channel.send({ embeds: [embed] });
    } catch (e) {
        console.error("Gagal mengirim laporan leaderboard:", e);
        return sendErrorEmbed(message.channel, `Gagal mengirim laporan. Detail: ${e.message}`);
    }
    return;
  }

  // --- COMMAND !help ---
  else if (cmd === "!help") {
      const helpEmbed = new EmbedBuilder()
          .setColor("#3498db")
          .setTitle("PUSAT BANTUAN | COMMAND UMUM")
          .setDescription("Navigasi cepat untuk pembeli. Gunakan tombol di bawah untuk interaksi, atau command di daftar.")
          .addFields(
              {
                  name: "A. Command Teks Utama",
                  value: [
                      "`!help`\t\t\t\t- Menampilkan menu ini.",
                      "`!qris`\t\t\t- Menampilkan kode QRIS untuk pembayaran.",
                      "`!price 7d/30d <qty>`\t- Cek total harga untuk jumlah pembelian tertentu.",
                      "`!leaderboard buyer` / `!lb buyer`\t- Cek peringkat **Pembeli Terbaik**.", 
                      "`!av/@user`\t\t\t- Melihat avatar pengguna.",
                      "\u200b",
                      "*Gunakan tombol di bawah untuk melihat riwayat pembelian dan harga grosir.*",
                  ].join('\n'),
                  inline: false,
              },
              {
                  name: "B. Bantuan Staf/Admin (Prefix '!')",
                  value: "Jika Anda memiliki hak akses Administrator/Staf, gunakan command: `!admin help`",
                  inline: false,
              }
          )
          .setFooter({ text: `Bluu Store Bot | ${message.guild.name}` })
          .setTimestamp();
      
      const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
              .setCustomId('HELP_QRIS')
              .setLabel('Scan QRIS')
              .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
              .setCustomId('HELP_BULK')
              .setLabel('Cek Harga Reseller')
              .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
              .setCustomId('HELP_MYHISTORY')
              .setLabel('Riwayat Beli Saya')
              .setStyle(ButtonStyle.Secondary)
      );
      
      message.channel.send({ embeds: [helpEmbed], components: [actionRow] });
  }

  // --- COMMAND !admin help ---
  else if (cmd === "!admin" && args[1]?.toLowerCase() === "help") {
    if (!member || !hasPermission(member)) {
        return sendErrorEmbed(message.channel, "Kamu tidak punya izin untuk mengakses bantuan Admin.");
    }
    
    const adminHelpEmbed = new EmbedBuilder()
        .setColor("#e74c3c")
        .setTitle("PUSAT BANTUAN | COMMAND ADMINISTRATOR")
        .setDescription("Daftar lengkap command yang dilindungi untuk staf Bluu Store. (Semua menggunakan Prefix `!`)")
        .addFields(
            {
                name: "A. Manajemen Stok & Penjualan (Prefix `!`)",
                value: [
                    "`!send 7d/30d <qty> @user`\t- Mengirim kode & mencatat penjualan.",
                    "`!addcode 7d/30d <code>`\t- Menambahkan satu kode baru.",
                    "`!import 7d/30d` + `.txt`\t- Impor kode massal dari file teks.",
                    "`!view code 7d/30d`\t\t- Melihat semua kode yang belum terpakai.",
                    "`!sales daily/monthly/total`\t- Melihat laporan penjualan.",
                    "`!leaderboard seller` / `!lb seller`\t- Melihat peringkat **Penjual Terbaik**.", 
                    "`!embed #channel`\t\t- Membuka form untuk membuat dan mengirim embed.",
                ].join('\n'),
                inline: false,
            },
            {
                name: "B. Moderasi (Prefix `!`)",
                value: [
                    "`!addrole @user @role`\t- Memberikan role kepada user.",
                    "`!mute @user <durasi>`\t- Memberikan Timeout. Contoh: `5m`, `2h`, `1d`.",
                    "`!unmute @user`\t\t- Menghapus Timeout.",
                    "`!av/@user`\t\t\t- Melihat avatar pengguna lain.",
                    "`!admin help`\t\t- Menampilkan menu ini.",
                ].join('\n'),
                inline: false,
            }
        )
        .setFooter({ text: `Akses Terbatas: Staf ${message.guild.name}` })
        .setTimestamp();

    message.channel.send({ embeds: [adminHelpEmbed] });
  }

  // --- COMMAND !view code ---
  const isViewCode = cmd === '!view' && args[1]?.toLowerCase() === 'code';
  if (isViewCode) {
    if (!member || !hasPermission(member))
        return sendErrorEmbed(message.channel, "Kamu tidak punya izin untuk melihat kode.");
        
    const typeArg = args[2]?.toLowerCase();
    const type = typeArg === "7d" ? "VIP7D" : typeArg === "30d" ? "VIP30D" : null;

    if (!type) {
        return sendErrorEmbed(message.channel, "Format salah. Gunakan: `!view code 7d` atau `!view code 30d`.");
    }

    const codes = await queryUnusedCodes(type);
    if (codes.length === 0)
      return sendEmbed(message.channel, `Tidak ada kode ${type} yang belum terpakai.`);

    if (codes.length > 200) {
      const fileContent = codes.join("\n");
      const filename = `${type}_Unused_${Date.now()}.txt`;
      const filepath = path.join(__dirname, filename);
      fs.writeFileSync(filepath, fileContent, "utf8");
      const attachment = new AttachmentBuilder(filepath);

      try {
          await message.author.send({ 
              content: `Berikut adalah file berisi **${codes.length} kode ${type}** yang belum terpakai.`,
              files: [attachment] 
          });
          sendSuccessEmbed(message.channel, `Daftar ${codes.length} kode ${type} telah dikirim ke DM Anda dalam bentuk file (.txt).`, "Kode Dikirim via DM");
      } catch {
          sendErrorEmbed(message.channel, "Gagal mengirimkan file kode ke DM Anda. Pastikan DM Anda terbuka.");
      } finally {
          fs.unlinkSync(filepath);
      }
      return;
    }

    return sendEmbed(message.channel, codes.join("\n"));
  }

  // --- COMMAND !av / !avatar ---
  else if (cmd === "!av" || cmd === "!avatar") {

    let targetUser = message.mentions.users.first() || message.author;
    
    if (!message.mentions.users.first() && args[1]) {
        const fetchedUser = await client.users.fetch(args[1]).catch(() => null);
        if (fetchedUser) targetUser = fetchedUser;
    }
    
    if (!targetUser) {
        return sendErrorEmbed(message.channel, "Pengguna tidak ditemukan. Tag pengguna atau gunakan ID yang valid.");
    }
    
    const avatarURL = targetUser.displayAvatarURL({ dynamic: true, size: 1024 });

    const avatarEmbed = new EmbedBuilder()
      .setColor("#3498db")
      .setTitle(`Avatar dari ${targetUser.tag}`)
      .setImage(avatarURL)
      .setDescription(`[Klik di sini untuk melihat gambar resolusi penuh (${targetUser.tag})](${avatarURL})`)
      .setFooter({ text: `ID Pengguna: ${targetUser.id}` })
      .setTimestamp();
      
    try {
        await message.channel.send({ embeds: [avatarEmbed] });
    } catch (e) {
        console.error("Gagal mengirim embed avatar:", e);
        sendErrorEmbed(message.channel, "Gagal menampilkan avatar.");
    }
  }


}); // <--- Akhir dari client.on("messageCreate")

// --- INTERACTION CREATE EVENT ---
client.on("interactionCreate", async (interaction) => {
    
    if (!interaction.guild) return; 

    if (interaction.isButton()) {
        await interaction.deferReply({ ephemeral: true });

        if (interaction.customId === 'HELP_QRIS') {
            const qrisEmbed = new EmbedBuilder()
                .setColor("#0099ff")
                .setTitle("Pembayaran QRIS Redfinger Bluu Store")
                .setDescription("Silakan scan kode QRIS di bawah ini untuk menyelesaikan pembayaran Anda.")
                .setImage(QRIS_IMAGE_URL)
                .setFooter({ text: "Pastikan jumlah transfer sudah sesuai." })
                .setTimestamp();
                
            await interaction.editReply({ 
                embeds: [qrisEmbed], 
                ephemeral: true 
            });
            
        } else if (interaction.customId === 'HELP_BULK') {
            const BULK_QTY = 20; 
            const BULK_PRICE_7D = 19000; 
            const BULK_PRICE_30D = 58000; 

            const bulkEmbed = new EmbedBuilder()
                .setColor("#f1c40f")
                .setTitle("HARGA RESELLER | MINIMAL 20 KODE")
                .setDescription(`Dapatkan harga spesial per unit jika membeli minimal **${BULK_QTY} kode** dalam satu transaksi.`)
                .addFields(
                    { name: "VIP 7 Day", value: `Harga Satuan: **Rp${BULK_PRICE_7D.toLocaleString('id-ID')}**`, inline: true },
                    { name: "Total 20 Kode", value: `**Rp${(BULK_PRICE_7D * BULK_QTY).toLocaleString('id-ID')}**`, inline: true },
                    { name: "\u200b", value: "\u200b", inline: false },
                    { name: "VIP 30 Day", value: `Harga Satuan: **Rp${BULK_PRICE_30D.toLocaleString('id-ID')}**`, inline: true },
                    { name: "Total 20 Kode", value: `**Rp${(BULK_PRICE_30D * BULK_QTY).toLocaleString('id-ID')}**`, inline: true }
                )
                .setFooter({ text: "Hubungi Admin untuk proses pembelian untuk Reseller." })
                .setTimestamp();
                
            await interaction.editReply({ embeds: [bulkEmbed], ephemeral: true });

        } else if (interaction.customId === 'HELP_MYHISTORY') {
            const salesSummary = db.prepare(`
                SELECT type, SUM(qty) AS total_qty 
                FROM sales 
                WHERE user_id = ? 
                GROUP BY type
            `).all(interaction.user.id);

            if (salesSummary.length === 0) {
                return interaction.editReply({ content: `Hai ${interaction.user.tag}, Anda belum memiliki riwayat pembelian yang tercatat di Bluu Store.`, ephemeral: true });
            }

            const totalSold = salesSummary.reduce((sum, item) => sum + item.total_qty, 0);

            const historyEmbed = new EmbedBuilder()
                .setColor("#0099ff")
                .setTitle("RIWAYAT PEMBELIAN ANDA")
                .setDescription(`Ringkasan total **${totalSold.toLocaleString('id-ID')}** kode telah Anda beli dari Bluu Store.`)
                .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            const fields = salesSummary.map(item => ({
                name: `Total ${item.type}`,
                value: `${item.total_qty.toLocaleString('id-ID')} Kode`,
                inline: true
            }));

            historyEmbed.addFields(fields);
            historyEmbed.setFooter({ text: "Terima kasih telah menjadi pelanggan setia!" }).setTimestamp();
            
            await interaction.editReply({ embeds: [historyEmbed], ephemeral: true });
        }
        return; 
    }
    
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'embedModal') {
            if (!hasPermission(interaction.member)) {
                return interaction.reply({ content: "Kamu tidak punya izin untuk mengirim Embed.", ephemeral: true });
            }
            
            await interaction.deferReply({ ephemeral: true });
            
            const channelId = interaction.fields.getTextInputValue('embed_channel_id');
            const title = interaction.fields.getTextInputValue('embed_title');
            const description = interaction.fields.getTextInputValue('embed_description');
            const color = interaction.fields.getTextInputValue('embed_color');
            
            const targetChannel = await interaction.client.channels.fetch(channelId).catch(() => null);
            
            if (!targetChannel || !targetChannel.send) {
                return interaction.editReply({ content: "Gagal menemukan channel tujuan. Pastikan ID channel benar dan saya memiliki izin kirim pesan di sana.", ephemeral: true });
            }

            try {
                const embed = new EmbedBuilder()
                    .setTitle(title || null) 
                    .setDescription(description || null) 
                    .setColor(color || 0x3498db) 
                    .setTimestamp();

                await targetChannel.send({ embeds: [embed] });
                
                return interaction.editReply({ content: `Berhasil mengirim Embed ke channel <#${targetChannel.id}>!`, ephemeral: true });
            } catch (e) {
                console.error("Gagal mengirim embed dari modal:", e);
                return interaction.editReply({ content: `Terjadi kesalahan saat mencoba mengirim Embed: \`${e.message}\``, ephemeral: true });
            }
        }
        return;
    }
});


client.login(TOKEN);
