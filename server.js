
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const GUILD_ID = "1553429884582502400";

const APPROVAL_ROLES = new Set([
  "1553836431913386047",
  "1553826346713489458",
  "1553774180112138240"
]);

if (!API_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Gerekli ortam değişkenleri eksik.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

app.get("/health", (req, res) => {
  res.json({
    online: true,
    project: "Vindelst Company API"
  });
});

app.use((req, res, next) => {
  if (req.get("authorization") !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: "Yetkisiz erişim." });
  }
  next();
});

function validDiscordId(value) {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}

function validCompanyId(value) {
  return /^\d+$/.test(String(value)) &&
    Number(value) > 0 &&
    Number.isSafeInteger(Number(value));
}

function validAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) &&
    amount > 0 &&
    amount <= 1000000000000;
}

function sendDbError(res, error) {
  const message = String(error?.message || "");

  if (message.includes("COMPANY_NOT_FOUND")) {
    return res.status(404).json({ error: "Şirket bulunamadı veya aktif değil." });
  }
  if (message.includes("INSUFFICIENT_BALANCE")) {
    return res.status(400).json({ error: "Şirket kasasında yeterli para yok." });
  }
  if (message.includes("MAX_LEVEL")) {
    return res.status(400).json({ error: "Şirket zaten maksimum 6. seviyede." });
  }
  if (message.includes("INVALID_CASH_REQUEST")) {
    return res.status(400).json({ error: "Geçersiz kasa işlemi." });
  }
  if (message.includes("APPLICATION_NOT_FOUND")) {
    return res.status(404).json({ error: "Başvuru bulunamadı." });
  }
  if (message.includes("APPLICATION_ALREADY_DECIDED")) {
    return res.status(409).json({ error: "Bu başvuru daha önce sonuçlandırılmış." });
  }

  console.error("Supabase hatası:", message);
  return res.status(500).json({ error: "İşlem sırasında sunucu hatası oluştu." });
}

async function getDiscordMember(userId) {
  if (!DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN_MISSING");
  }

  const response = await fetch(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`,
    {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`
      }
    }
  );

  if (response.status === 404) return null;

  if (!response.ok) {
    const error = new Error("DISCORD_MEMBER_LOOKUP_FAILED");
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function getDiscordRoles(userId) {
  const member = await getDiscordMember(userId);
  return member ? member.roles || [] : null;
}

async function isAdmin(userId) {
  const roles = await getDiscordRoles(userId);
  if (!roles) return false;
  return roles.some(roleId => APPROVAL_ROLES.has(roleId));
}

async function getCompany(companyId) {
  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .eq("id", companyId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function isCompanyOwner(companyId, userId) {
  const { data, error } = await supabase
    .from("company_members")
    .select("id")
    .eq("company_id", companyId)
    .eq("discord_user_id", userId)
    .eq("role", "owner")
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

async function isCompanyMember(companyId, userId) {
  const { data, error } = await supabase
    .from("company_members")
    .select("id")
    .eq("company_id", companyId)
    .eq("discord_user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

async function canViewCompany(companyId, userId) {
  return (await isAdmin(userId)) ||
    (await isCompanyMember(companyId, userId));
}

function requireIds(companyId, userId) {
  return validCompanyId(companyId) && validDiscordId(userId);
}

// --------------------------------------------------
// ŞİRKET BAŞVURUSU
// --------------------------------------------------

app.post("/applications", async (req, res) => {
  try {
    const { name, company_type, owner_discord_id } = req.body;

    if (
      typeof name !== "string" ||
      name.trim().length < 2 ||
      name.trim().length > 80 ||
      typeof company_type !== "string" ||
      company_type.trim().length < 2 ||
      company_type.trim().length > 60 ||
      !validDiscordId(owner_discord_id)
    ) {
      return res.status(400).json({ error: "Başvuru bilgileri geçersiz." });
    }

    const { data: existing, error: existingError } = await supabase
      .from("company_applications")
      .select("id")
      .eq("owner_discord_id", owner_discord_id)
      .eq("status", "pending")
      .limit(1);

    if (existingError) throw existingError;

    if (existing?.length) {
      return res.status(409).json({
        error: "Bekleyen bir şirket başvurun zaten var."
      });
    }

    const { data, error } = await supabase
      .from("company_applications")
      .insert({
        name: name.trim(),
        company_type: company_type.trim(),
        owner_discord_id,
        status: "pending"
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      success: true,
      application: data
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// --------------------------------------------------
// BAŞVURU ONAYLAMA / REDDETME
// --------------------------------------------------

app.post("/applications/decision", async (req, res) => {
  try {
    const {
      application_id,
      decision,
      reviewer_discord_id
    } = req.body;

    if (
      !validCompanyId(application_id) ||
      !["Onayla", "Reddet"].includes(decision) ||
      !validDiscordId(reviewer_discord_id)
    ) {
      return res.status(400).json({ error: "Başvuru kararı geçersiz." });
    }

    const roles = await getDiscordRoles(reviewer_discord_id);

    if (!roles) {
      return res.status(403).json({ error: "Discord üyesi sunucuda bulunamadı." });
    }

    if (!roles.some(roleId => APPROVAL_ROLES.has(roleId))) {
      return res.status(403).json({ error: "Bu işlem için yetkin yok." });
    }

    const { data, error } = await supabase.rpc(
      "decide_company_application",
      {
        p_application_id: Number(application_id),
        p_decision: decision,
        p_reviewer_discord_id: reviewer_discord_id
      }
    );

    if (error) throw error;

    return res.json({
      success: true,
      result: data
    });
  } catch (error) {
    if (error.message === "DISCORD_BOT_TOKEN_MISSING") {
      return res.status(500).json({ error: "Discord bot tokeni yapılandırılmamış." });
    }
    if (error.status) {
      return res.status(502).json({ error: "Discord üye kontrolü başarısız." });
    }
    return sendDbError(res, error);
  }
});

// --------------------------------------------------
// AKTİF ŞİRKETLERİ LİSTELE
// GET /companies
// --------------------------------------------------

app.get("/companies", async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit || 50);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 50;

    const { data, error } = await supabase
      .from("companies")
      .select("id, name, company_type, owner_discord_id, balance, total_revenue, total_expenses, level, created_at")
      .eq("is_active", true)
      .order("id", { ascending: true })
      .limit(limit);

    if (error) throw error;

    return res.json({
      success: true,
      companies: data || []
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// --------------------------------------------------
// ŞİRKETİM
// GET /companies/mine?user_id=DISCORD_ID
// --------------------------------------------------

app.get("/companies/mine", async (req, res) => {
  try {
    const userId = req.query.user_id;

    if (!validDiscordId(userId)) {
      return res.status(400).json({ error: "Geçerli bir user_id gerekli." });
    }

    const { data: memberships, error: memberError } = await supabase
      .from("company_members")
      .select("company_id, role")
      .eq("discord_user_id", userId);

    if (memberError) throw memberError;

    const companyIds = [...new Set((memberships || []).map(row => row.company_id))];

    if (!companyIds.length) {
      return res.json({ success: true, companies: [] });
    }

    const { data: companies, error: companyError } = await supabase
      .from("companies")
      .select("id, name, company_type, owner_discord_id, balance, total_revenue, total_expenses, level, created_at")
      .in("id", companyIds)
      .eq("is_active", true);

    if (companyError) throw companyError;

    const results = (companies || []).map(company => ({
      ...company,
      role: memberships.find(row => String(row.company_id) === String(company.id))?.role
    }));

    return res.json({ success: true, companies: results });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// --------------------------------------------------
// ŞİRKET KASASINI GÖRÜNTÜLE
// GET /companies/:id/cash?user_id=DISCORD_ID
// --------------------------------------------------

app.get("/companies/:id/cash", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.query.user_id;

    if (!requireIds(id, userId)) {
      return res.status(400).json({ error: "Şirket veya kullanıcı ID'si geçersiz." });
    }

    if (!(await canViewCompany(id, userId))) {
      return res.status(403).json({ error: "Bu şirketin kasasını görüntüleme yetkin yok." });
    }

    const company = await getCompany(Number(id));

    if (!company) {
      return res.status(404).json({ error: "Şirket bulunamadı veya aktif değil." });
    }

    return res.json({
      success: true,
      company_id: company.id,
      name: company.name,
      balance: company.balance,
      level: company.level
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// --------------------------------------------------
// KASAYA PARA EKLE / KASADAN PARA SİL
// POST /companies/:id/cash
// Body: { user_id, action: "ekle"|"sil", amount }
// Yalnızca yetkili yönetici rolleri kullanabilir.
// --------------------------------------------------

app.post("/companies/:id/cash", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, action, amount } = req.body;

    if (!requireIds(id, user_id)) {
      return res.status(400).json({ error: "Şirket veya kullanıcı ID'si geçersiz." });
    }

    if (!["ekle", "sil"].includes(action) || !validAmount(amount)) {
      return res.status(400).json({ error: "İşlem veya miktar geçersiz." });
    }

    if (!(await isAdmin(user_id))) {
      return res.status(403).json({ error: "Kasa düzenleme yetkin yok." });
    }

    const { data, error } = await supabase.rpc("manage_company_cash", {
      p_company_id: Number(id),
      p_action: action,
      p_amount: Number(amount),
      p_actor_discord_id: user_id
    });

    if (error) throw error;

    return res.json(data);
  } catch (error) {
    if (error.message === "DISCORD_BOT_TOKEN_MISSING") {
      return res.status(500).json({ error: "Discord bot tokeni yapılandırılmamış." });
    }
    if (error.status) {
      return res.status(502).json({ error: "Discord üye kontrolü başarısız." });
    }
    return sendDbError(res, error);
  }
});

// --------------------------------------------------
// ŞİRKETİ YÜKSELT
// POST /companies/:id/upgrade
// Body: { user_id }
// Yalnızca şirket sahibi yükseltebilir.
// --------------------------------------------------

app.post("/companies/:id/upgrade", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.body;

    if (!requireIds(id, user_id)) {
      return res.status(400).json({ error: "Şirket veya kullanıcı ID'si geçersiz." });
    }

    if (!(await isCompanyOwner(id, user_id))) {
      return res.status(403).json({ error: "Şirketi yükseltme yetkisi yalnızca sahibinde." });
    }

    const { data, error } = await supabase.rpc("upgrade_company", {
      p_company_id: Number(id),
      p_actor_discord_id: user_id
    });

    if (error) throw error;

    return res.json(data);
  } catch (error) {
    return sendDbError(res, error);
  }
});

// --------------------------------------------------
// ÇALIŞAN EKLE
// POST /companies/:id/members
// Body: { user_id: OWNER_ID, member_discord_id: NEW_MEMBER_ID }
// --------------------------------------------------

app.post("/companies/:id/members", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, member_discord_id } = req.body;

    if (
      !requireIds(id, user_id) ||
      !validDiscordId(member_discord_id)
    ) {
      return res.status(400).json({ error: "Şirket veya kullanıcı ID'si geçersiz." });
    }

    if (!(await isCompanyOwner(id, user_id))) {
      return res.status(403).json({ error: "Çalışan ekleme yetkisi yalnızca şirkette." });
    }

    const company = await getCompany(Number(id));

    if (!company) {
      return res.status(404).json({ error: "Şirket bulunamadı veya aktif değil." });
    }

    const member = await getDiscordMember(member_discord_id);

    if (!member) {
      return res.status(404).json({ error: "Eklenecek kullanıcı Discord sunucusunda bulunamadı." });
    }

    const { data: existing, error: existingError } = await supabase
      .from("company_members")
      .select("id, company_id")
      .eq("discord_user_id", member_discord_id)
      .limit(1);

    if (existingError) throw existingError;

    if (existing?.length) {
      return res.status(409).json({
        error: "Bu kullanıcı zaten bir şirkete kayıtlı."
      });
    }

    const { data, error } = await supabase
      .from("company_members")
      .insert({
        company_id: Number(id),
        discord_user_id: member_discord_id,
        role: "partner"
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      success: true,
      member: data
    });
  } catch (error) {
    if (error.message === "DISCORD_BOT_TOKEN_MISSING") {
      return res.status(500).json({ error: "Discord bot tokeni yapılandırılmamış." });
    }
    if (error.status) {
      return res.status(502).json({ error: "Discord üye kontrolü başarısız." });
    }
    return sendDbError(res, error);
  }
});

// --------------------------------------------------
// ÇALIŞAN SİL
// DELETE /companies/:id/members/:memberId
// Query: ?user_id=OWNER_ID
// --------------------------------------------------

app.delete("/companies/:id/members/:memberId", async (req, res) => {
  try {
    const { id, memberId } = req.params;
    const userId = req.query.user_id;

    if (
      !requireIds(id, userId) ||
      !validDiscordId(memberId)
    ) {
      return res.status(400).json({ error: "Şirket veya kullanıcı ID'si geçersiz." });
    }

    if (!(await isCompanyOwner(id, userId))) {
      return res.status(403).json({ error: "Çalışan silme yetkisi yalnızca şirkette." });
    }

    if (userId === memberId) {
      return res.status(400).json({ error: "Şirket sahibi bu uç noktadan silinemez." });
    }

    const { data: target, error: targetError } = await supabase
      .from("company_members")
      .select("id, role")
      .eq("company_id", Number(id))
      .eq("discord_user_id", memberId)
      .maybeSingle();

    if (targetError) throw targetError;

    if (!target) {
      return res.status(404).json({ error: "Bu çalışan şirkette bulunamadı." });
    }

    if (target.role === "owner") {
      return res.status(400).json({ error: "Şirket sahibi çalışan olarak silinemez." });
    }

    const { error } = await supabase
      .from("company_members")
      .delete()
      .eq("company_id", Number(id))
      .eq("discord_user_id", memberId);

    if (error) throw error;

    return res.json({
      success: true,
      message: "Çalışan şirketten çıkarıldı."
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// --------------------------------------------------
// ŞİRKETİ SİL (SOFT DELETE)
// DELETE /companies/:id
// Query: ?user_id=DISCORD_ID
// Şirket sahibi veya yönetici rolü gerekir.
// --------------------------------------------------

app.delete("/companies/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.query.user_id;

    if (!requireIds(id, userId)) {
      return res.status(400).json({ error: "Şirket veya kullanıcı ID'si geçersiz." });
    }

    const authorized =
      (await isCompanyOwner(id, userId)) ||
      (await isAdmin(userId));

    if (!authorized) {
      return res.status(403).json({ error: "Şirket silme yetkin yok." });
    }

    const { data, error } = await supabase
      .from("companies")
      .update({ is_active: false })
      .eq("id", Number(id))
      .eq("is_active", true)
      .select("id, name")
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({ error: "Şirket bulunamadı veya zaten silinmiş." });
    }

    return res.json({
      success: true,
      message: "Şirket pasifleştirildi.",
      company: data
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// --------------------------------------------------
// GENEL HATA YÖNETİMİ
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error("Beklenmeyen API hatası:", error?.message || error);

  if (res.headersSent) return next(error);

  return res.status(500).json({
    error: "Beklenmeyen sunucu hatası."
  });
});

app.listen(PORT, () => {
  console.log(`Vindelst Company API ${PORT} portunda çalışıyor.`);
});
