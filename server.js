
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "20kb" }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!API_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Gerekli ortam değişkenleri eksik.");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

app.get("/health", (req, res) => {
  res.json({ online: true, project: "Vindelst Company API" });
});

app.use((req, res, next) => {
  if (req.get("authorization") !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: "Yetkisiz erişim." });
  }
  next();
});

app.get("/companies", async (req, res) => {
  const { data, error } = await supabase
    .from("companies")
    .select("id,name,company_type,owner_discord_id,balance,total_revenue,total_expenses,is_active,created_at")
    .eq("is_active", true)
    .order("id", { ascending: true });

  if (error) {
    console.error("Şirket listesi alınamadı:", error.message);
    return res.status(500).json({ error: "Şirketler alınamadı." });
  }

  res.json({ companies: data });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vindelst Company API ${PORT} portunda çalışıyor.`);
});
    
