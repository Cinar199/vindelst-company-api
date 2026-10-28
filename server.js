const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!API_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Gerekli ortam değişkenleri eksik.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const APPROVAL_ROLES = new Set([
  "1553836431913386047",
  "1553826346713489458",
  "1553774180112138240"
]);

app.get("/health", (req, res) => {
  res.json({ online: true, project: "Vindelst Company API" });
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

// Başvuru oluştur
app.post("/applications", async (req, res) => {
  try {
    const { name, company_type, owner_discord_id } = req.body || {};

    if (
      typeof name !== "string" || name.trim().length < 2 ||
      name.trim().length > 80 ||
      typeof company_type !== "string" ||
      company_type.trim().length < 2 ||
      company_type.trim().length > 80 ||
      !validDiscordId(owner_discord_id)
    ) {
      return res.status(400).json({ error: "Başvuru bilgileri geçersiz." });
    }

    const { data: pending, error: findError } = await supabase
      .from("company_applications")
      .select("id")
      .eq("owner_discord_id", owner_discord_id)
      .eq("status", "pending")
      .limit(1);

    if (findError) throw findError;

    if (pending && pending.length) {
      return res.status(409).json({
        error: "Bekleyen bir başvurun zaten var.",
        application_id: pending[0].id
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
      .select("id,name,company_type,owner_discord_id,status,created_at")
      .single();

    if (error) throw error;

    return res.status(201).json({ success: true, application: data });
  } catch (error) {
    console.error("Başvuru oluşturma hatası:", error.message);
    return res.status(500).json({ error: "Başvuru kaydedilemedi." });
  }
});

// Başvuru kararı
app.post("/applications/decision", async (req, res) => {
  try {
    const {
      application_id,
      decision,
      reviewer_discord_id,
      reviewer_role_id
    } = req.body || {};

    if (
      !/^\d+$/.test(String(application_id || "")) ||
      !["Onayla", "Reddet"].includes(decision) ||
      !validDiscordId(reviewer_discord_id) ||
      !APPROVAL_ROLES.has(reviewer_role_id)
    ) {
      return res.status(400).json({ error: "Karar bilgileri geçersiz." });
    }

    const { data, error } = await supabase.rpc(
      "decide_company_application",
      {
        p_application_id: Number(application_id),
        p_decision: decision,
        p_reviewer_discord_id: reviewer_discord_id
      }
    );

    if (error) {
      console.error("Başvuru karar hatası:", error.message);

      if (error.message.includes("APPLICATION_NOT_FOUND")) {
        return res.status(404).json({ error: "Başvuru bulunamadı." });
      }

      if (error.message.includes("APPLICATION_ALREADY_DECIDED")) {
        return res.status(409).json({
          error: "Başvuru daha önce sonuçlandırılmış."
        });
      }

      return res.status(500).json({ error: "Başvuru karara bağlanamadı." });
    }

    return res.json(data);
  } catch (error) {
    console.error("Karar işleme hatası:", error.message);
    return res.status(500).json({ error: "İşlem tamamlanamadı." });
  }
});

app.use((err, req, res, next) => {
  console.error("İstek hatası:", err.message);
  res.status(400).json({ error: "İstek biçimi geçersiz." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vindelst Company API ${PORT} portunda çalışıyor.`);
});
