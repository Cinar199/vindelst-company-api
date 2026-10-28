
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "20kb" }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  res.json({ online: true, project: "Vindelst Company API" });
});

app.use((req, res, next) => {
  if (req.get("authorization") !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: "Yetkisiz erişim." });
  }
  next();
});

app.post("/companies", async (req, res) => {
  const { name, company_type, owner_discord_id } = req.body || {};

  if (
    typeof name !== "string" ||
    name.trim().length < 2 ||
    name.trim().length > 80 ||
    typeof company_type !== "string" ||
    company_type.trim().length < 2 ||
    company_type.trim().length > 40 ||
    typeof owner_discord_id !== "string" ||
    !/^\d{17,20}$/.test(owner_discord_id)
  ) {
    return res.status(400).json({
      error: "Şirket adı, türü veya Discord kullanıcı ID'si geçersiz."
    });
  }

  const cleanName = name.trim();
  const cleanType = company_type.trim();

  const { data, error } = await supabase
    .from("companies")
    .insert({
      name: cleanName,
      company_type: cleanType,
      owner_discord_id,
      balance: 0
    })
    .select("id,name,company_type,owner_discord_id,balance,created_at")
    .single();

  if (error) {
    console.error("Şirket oluşturma hatası:", error.message);
    return res.status(500).json({ error: "Şirket oluşturulamadı." });
  }

  const { error: memberError } = await supabase
    .from("company_members")
    .insert({
      company_id: data.id,
      discord_user_id: owner_discord_id,
      role: "owner"
    });

  if (memberError) {
    await supabase.from("companies").delete().eq("id", data.id);
    console.error("Sahip kaydı hatası:", memberError.message);
    return res.status(500).json({ error: "Şirket sahibi kaydedilemedi." });
  }

  res.status(201).json({ success: true, company: data });
});

app.get("/companies", async (req, res) => {
  const { data, error } = await supabase
    .from("companies")
    .select("id,name,company_type,owner_discord_id,balance,total_revenue,total_expenses,is_active,created_at")
    .eq("is_active", true)
    .order("id", { ascending: true });

  if (error) {
    console.error("Şirket listesi hatası:", error.message);
    return res.status(500).json({ error: "Şirketler alınamadı." });
  }

  res.json({ companies: data });
});

app.use((err, req, res, next) => {
  console.error("İstek hatası:", err.message);
  res.status(400).json({ error: "İstek biçimi geçersiz." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vindelst Company API ${PORT} portunda çalışıyor.`);
});
