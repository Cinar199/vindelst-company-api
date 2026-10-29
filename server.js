const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_SECRET = process.env.API_SECRET;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const GUILD_ID = "1553429884582502400";

const APPROVAL_ROLES = [
  "1553836431913386047",
  "1553826346713489458",
  "1553774180112138240",
];

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !API_SECRET) {
  throw new Error("Supabase veya API ortam değişkenleri eksik.");
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

// API güvenliği
app.use((req, res, next) => {
  if (req.path === "/health") return next();

  const authorization = req.headers.authorization;

  if (authorization !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({
      success: false,
      error: "Yetkisiz erişim.",
    });
  }

  next();
});

// Discord sunucu üyesini getir
async function getDiscordMember(userId) {
  if (!DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN ayarlanmamış.");
  }

  const response = await fetch(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`,
    {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) return null;

    throw new Error(
      `Discord API hatası: ${response.status}`
    );
  }

  return response.json();
}

// Yetkili rol kontrolü
async function hasApprovalRole(userId) {
  const member = await getDiscordMember(userId);

  if (!member) return false;

  return member.roles.some((role) =>
    APPROVAL_ROLES.includes(role)
  );
}

// Şirket üyeliğini getir
async function getCompanyMembership(companyId, userId) {
  const { data, error } = await supabase
    .from("company_members")
    .select("*")
    .eq("company_id", companyId)
    .eq("discord_user_id", userId)
    .maybeSingle();

  if (error) throw error;

  return data;
}

// Şirket sahibi kontrolü
async function isCompanyOwner(companyId, userId) {
  const { data, error } = await supabase
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .eq("owner_discord_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;

  return Boolean(data);
}

// Yönetici rol kontrolü
async function isAuthorizedManager(userId) {
  return hasApprovalRole(userId);
}

// Sağlık kontrolü
app.get("/health", (req, res) => {
  res.json({
    online: true,
    project: "Vindelst Company API",
  });
});

// Şirket başvurusu oluştur
app.post("/applications", async (req, res, next) => {
  try {
    const {
      name,
      company_type,
      owner_discord_id,
    } = req.body;

    if (!name || !company_type || !owner_discord_id) {
      return res.status(400).json({
        success: false,
        error: "Şirket adı, türü ve Discord kullanıcı ID'si gerekli.",
      });
    }

    const { data: existing, error: existingError } =
      await supabase
        .from("company_applications")
        .select("id")
        .eq("owner_discord_id", String(owner_discord_id))
        .eq("status", "pending")
        .maybeSingle();

    if (existingError) throw existingError;

    if (existing) {
      return res.status(409).json({
        success: false,
        error: "Bekleyen bir şirket başvurun zaten var.",
      });
    }

    const { data, error } = await supabase
      .from("company_applications")
      .insert({
        name: String(name).trim(),
        company_type: String(company_type).trim(),
        owner_discord_id: String(owner_discord_id),
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: "Şirket başvurusu oluşturuldu.",
      application: data,
    });
  } catch (error) {
    next(error);
  }
});

// Şirket başvurusunu onayla veya reddet
app.post(
  "/applications/decision",
  async (req, res, next) => {
    try {
      const {
        application_id,
        decision,
        reviewer_discord_id,
      } = req.body;

      if (
        !application_id ||
        !["Onayla", "Reddet"].includes(decision) ||
        !reviewer_discord_id
      ) {
        return res.status(400).json({
          success: false,
          error: "Başvuru ID'si, karar ve inceleyen kullanıcı gerekli.",
        });
      }

      const authorized = await hasApprovalRole(
        String(reviewer_discord_id)
      );

      if (!authorized) {
        return res.status(403).json({
          success: false,
          error: "Bu işlem için yetkin yok.",
        });
      }

      const { data, error } = await supabase.rpc(
        "decide_company_application",
        {
          p_application_id: Number(application_id),
          p_decision: decision,
          p_reviewer_discord_id: String(reviewer_discord_id),
        }
      );

      if (error) throw error;

      res.json({
        success: true,
        result: data,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Aktif şirketleri listele
app.get("/companies", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("companies")
      .select("*")
      .eq("is_active", true)
      .order("name", { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      companies: data,
    });
  } catch (error) {
    next(error);
  }
});

// Kullanıcının şirketlerini getir
app.get("/companies/mine", async (req, res, next) => {
  try {
    const userId = String(req.query.user_id || "");

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "user_id gerekli.",
      });
    }

    const { data: memberships, error } = await supabase
      .from("company_members")
      .select("company_id, role")
      .eq("discord_user_id", userId);

    if (error) throw error;

    const { data: owned, error: ownedError } = await supabase
      .from("companies")
      .select("*")
      .eq("owner_discord_id", userId)
      .eq("is_active", true);

    if (ownedError) throw ownedError;

    const companyIds = [
      ...new Set([
        ...(memberships || []).map((m) => m.company_id),
        ...(owned || []).map((c) => c.id),
      ]),
    ];

    let companies = [];

    if (companyIds.length > 0) {
      const { data, error: companiesError } = await supabase
        .from("companies")
        .select("*")
        .in("id", companyIds)
        .eq("is_active", true);

      if (companiesError) throw companiesError;

      companies = (data || []).map((company) => {
        const membership = (memberships || []).find(
          (m) => Number(m.company_id) === Number(company.id)
        );

        return {
          ...company,
          role:
            String(company.owner_discord_id) === userId
              ? "owner"
              : membership?.role || "partner",
        };
      });
    }

    res.json({
      success: true,
      companies,
    });
  } catch (error) {
    next(error);
  }
});

// Şirket kasasını görüntüle
app.get("/companies/:id/cash", async (req, res, next) => {
  try {
    const companyId = Number(req.params.id);
    const userId = String(req.query.user_id || "");

    if (!Number.isInteger(companyId) || companyId < 1 || !userId) {
      return res.status(400).json({
        success: false,
        error: "Geçerli şirket ID'si ve user_id gerekli.",
      });
    }

    const { data: company, error } = await supabase
      .from("companies")
      .select("*")
      .eq("id", companyId)
      .eq("is_active", true)
      .maybeSingle();

    if (error) throw error;

    if (!company) {
      return res.status(404).json({
        success: false,
        error: "Şirket bulunamadı.",
      });
    }

    const membership = await getCompanyMembership(
      companyId,
      userId
    );

    const owner =
      String(company.owner_discord_id) === userId;
    const manager = await isAuthorizedManager(userId);

    if (!owner && !membership && !manager) {
      return res.status(403).json({
        success: false,
        error: "Bu şirketin kasasını görüntüleme yetkin yok.",
      });
    }

    res.json({
      success: true,
      company_id: company.id,
      company_name: company.name,
      balance: company.balance,
      total_revenue: company.total_revenue,
      total_expenses: company.total_expenses,
    });
  } catch (error) {
    next(error);
  }
});

// Şirket kasası işlemleri: gelir, gider, sermaye
app.post("/companies/:id/cash", async (req, res, next) => {
  try {
    const companyId = Number(req.params.id);
    const {
      action,
      amount,
      user_id,
    } = req.body;

    const userId = String(user_id || "");
    const numericAmount = Number(amount);

    if (
      !Number.isInteger(companyId) ||
      companyId < 1 ||
      !userId ||
      !["gelir", "gider", "sermaye"].includes(action) ||
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "İşlem bilgileri geçersiz.",
      });
    }

    const { data: company, error } = await supabase
      .from("companies")
      .select("id, owner_discord_id")
      .eq("id", companyId)
      .eq("is_active", true)
      .maybeSingle();

    if (error) throw error;

    if (!company) {
      return res.status(404).json({
        success: false,
        error: "Şirket bulunamadı.",
      });
    }

    if (action === "sermaye") {
      const owner =
        String(company.owner_discord_id) === userId;

      if (!owner) {
        return res.status(403).json({
          success: false,
          error: "Sermaye ekleme işlemini yalnızca şirket sahibi yapabilir.",
        });
      }
    } else {
      const authorized = await isAuthorizedManager(userId);

      if (!authorized) {
        return res.status(403).json({
          success: false,
          error: "Gelir ve gider işlemleri için yönetici yetkisi gerekli.",
        });
      }
    }

    const { data, error: rpcError } = await supabase.rpc(
      "manage_company_cash",
      {
        p_company_id: companyId,
        p_action: action,
        p_amount: numericAmount,
        p_actor_discord_id: userId,
      }
    );

    if (rpcError) throw rpcError;

    res.json({
      success: true,
      result: data,
    });
  } catch (error) {
    next(error);
  }
});

// Şirket seviyesini yükselt
app.post("/companies/:id/upgrade", async (req, res, next) => {
  try {
    const companyId = Number(req.params.id);
    const userId = String(req.body.user_id || "");

    if (!Number.isInteger(companyId) || companyId < 1 || !userId) {
      return res.status(400).json({
        success: false,
        error: "Şirket ID'si ve user_id gerekli.",
      });
    }

    const owner = await isCompanyOwner(companyId, userId);

    if (!owner) {
      return res.status(403).json({
        success: false,
        error: "Şirket seviyesini yalnızca sahibi yükseltebilir.",
      });
    }

    const { data, error } = await supabase.rpc(
      "upgrade_company",
      {
        p_company_id: companyId,
        p_actor_discord_id: userId,
      }
    );

    if (error) throw error;

    res.json({
      success: true,
      result: data,
    });
  } catch (error) {
    next(error);
  }
});

// Şirkete ortak ekle
app.post("/companies/:id/members", async (req, res, next) => {
  try {
    const companyId = Number(req.params.id);
    const ownerId = String(req.body.user_id || "");
    const memberId = String(req.body.member_discord_id || "");

    if (
      !Number.isInteger(companyId) ||
      companyId < 1 ||
      !ownerId ||
      !memberId
    ) {
      return res.status(400).json({
        success: false,
        error: "Şirket ID'si, sahip ID'si ve ortak ID'si gerekli.",
      });
    }

    const owner = await isCompanyOwner(companyId, ownerId);

    if (!owner) {
      return res.status(403).json({
        success: false,
        error: "Ortak ekleme yetkisi yalnızca şirkete aittir.",
      });
    }

    const member = await getDiscordMember(memberId);

    if (!member) {
      return res.status(404).json({
        success: false,
        error: "Eklenecek kullanıcı Discord sunucusunda bulunamadı.",
      });
    }

    const { data: existing, error: existingError } =
      await supabase
        .from("company_members")
        .select("company_id")
        .eq("discord_user_id", memberId);

    if (existingError) throw existingError;

    if (existing && existing.length > 0) {
      return res.status(409).json({
        success: false,
        error: "Bu kullanıcı zaten bir şirkete bağlı.",
      });
    }

    const { data, error } = await supabase
      .from("company_members")
      .insert({
        company_id: companyId,
        discord_user_id: memberId,
        role: "partner",
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      member: data,
    });
  } catch (error) {
    next(error);
  }
});

// Şirket ortağını çıkar
app.delete(
  "/companies/:id/members/:memberId",
  async (req, res, next) => {
    try {
      const companyId = Number(req.params.id);
      const memberId = String(req.params.memberId);
      const ownerId = String(req.query.user_id || "");

      if (
        !Number.isInteger(companyId) ||
        companyId < 1 ||
        !memberId ||
        !ownerId
      ) {
        return res.status(400).json({
          success: false,
          error: "İşlem bilgileri eksik.",
        });
      }

      const owner = await isCompanyOwner(companyId, ownerId);

      if (!owner) {
        return res.status(403).json({
          success: false,
          error: "Ortak çıkarma yetkisi yalnızca şirkete aittir.",
        });
      }

      const { data: company, error: companyError } =
        await supabase
          .from("companies")
          .select("owner_discord_id")
          .eq("id", companyId)
          .maybeSingle();

      if (companyError) throw companyError;

      if (
        company &&
        String(company.owner_discord_id) === memberId
      ) {
        return res.status(400).json({
          success: false,
          error: "Şirket sahibi ortak olarak çıkarılamaz.",
        });
      }

      const { data, error } = await supabase
        .from("company_members")
        .delete()
        .eq("company_id", companyId)
        .eq("discord_user_id", memberId)
        .select();

      if (error) throw error;

      if (!data || data.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Şirket ortağı bulunamadı.",
        });
      }

      res.json({
        success: true,
        message: "Ortak şirketten çıkarıldı.",
      });
    } catch (error) {
      next(error);
    }
  }
);

// Şirketi pasifleştir
app.delete("/companies/:id", async (req, res, next) => {
  try {
    const companyId = Number(req.params.id);
    const userId = String(req.query.user_id || "");

    if (!Number.isInteger(companyId) || companyId < 1 || !userId) {
      return res.status(400).json({
        success: false,
        error: "Şirket ID'si ve user_id gerekli.",
      });
    }

    const owner = await isCompanyOwner(companyId, userId);

    if (!owner) {
      return res.status(403).json({
        success: false,
        error: "Şirketi yalnızca sahibi kapatabilir.",
      });
    }

    const { data, error } = await supabase
      .from("companies")
      .update({ is_active: false })
      .eq("id", companyId)
      .eq("owner_discord_id", userId)
      .eq("is_active", true)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: "Şirket kapatıldı.",
      company: data,
    });
  } catch (error) {
    next(error);
  }
});

// Bulunamayan endpoint
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint bulunamadı.",
  });
});

// Genel hata yakalayıcı
app.use((error, req, res, next) => {
  console.error("API hatası:", error.message);

  res.status(500).json({
    success: false,
    error: "Sunucu hatası oluştu.",
  });
});

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(
    `Vindelst Company API ${PORT} portunda çalışıyor.`
  );
});
