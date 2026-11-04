const express = require("express");
const router = express.Router();
const multer = require("multer");
const db = require("../db");
const { processCampaign } = require("../services/campaignProcessor");
const { uploadFileToCloudinary } = require("../services/cloudinaryService");
const os = require("os");
const path = require("path");
const { uploadMediaToMeta, getTemplates } = require("../services/metaApi");
const XLSX = require("xlsx");

const isValidUuid = (val) =>
  typeof val === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);

const uploadMedia = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
});

/**
 * POST /api/campaigns
 * Launch broadcast campaign across one or multiple contact lists
 */
router.post("/", uploadMedia.single("mediaFile"), async (req, res) => {
  try {
    const { name, template_name, language_code, contact_list_ids } = req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Campaign name is required." });
    }

    if (!template_name || typeof template_name !== "string" || !template_name.trim()) {
      return res.status(400).json({ error: "Template name is required." });
    }

    if (!contact_list_ids) {
      return res.status(400).json({ error: "At least one contact list must be selected." });
    }

    let parsedListIds = [];
    try {
      parsedListIds = typeof contact_list_ids === "string" ? JSON.parse(contact_list_ids) : contact_list_ids;
    } catch (e) {
      parsedListIds = [contact_list_ids];
    }

    if (!Array.isArray(parsedListIds)) {
      parsedListIds = [parsedListIds];
    }

    parsedListIds = parsedListIds.filter(isValidUuid);

    if (parsedListIds.length === 0) {
      return res.status(400).json({ error: "No valid contact lists were selected." });
    }

    // Inspect template to verify header requirements, language, and body parameters
    let paramCount = 0;
    let templateRequiresMediaHeader = false;
    let requiredHeaderFormat = null;
    let resolvedLanguageCode = language_code || "en_US";
    let templateFetched = false;

    try {
      const templates = await getTemplates();
      const tpl = (templates || []).find((t) => t.name === template_name.trim());
      if (tpl) {
        templateFetched = true;
        if (tpl.language) {
          resolvedLanguageCode = tpl.language;
        }
        if (tpl.components) {
          const headerComponent = tpl.components.find((c) => c.type === "HEADER");
          if (headerComponent && ["IMAGE", "VIDEO", "DOCUMENT"].includes(headerComponent.format)) {
            templateRequiresMediaHeader = true;
            requiredHeaderFormat = headerComponent.format.toLowerCase();
          }

          const bodyComponent = tpl.components.find((c) => c.type === "BODY");
          if (bodyComponent && bodyComponent.text) {
            const matches = bodyComponent.text.match(/\{\{\d+\}\}/g);
            if (matches) paramCount = new Set(matches).size;
          }
        }
      }
    } catch (err) {
      console.warn("Could not fetch templates to check params:", err.message);
    }

    const incomingMediaUrl = req.body.media_url || req.body.existing_media_url || null;
    const incomingMediaId = req.body.media_id || null;

    if (templateFetched && templateRequiresMediaHeader && !req.file && !incomingMediaUrl && !incomingMediaId) {
      return res.status(400).json({
        error: `Template "${template_name.trim()}" requires a ${requiredHeaderFormat} header. Please attach a ${requiredHeaderFormat} file or select from Media Gallery before launching.`,
      });
    }

    let media_id = incomingMediaId || null;
    let media_type = null;
    let media_url = incomingMediaUrl ? incomingMediaUrl.replace(/http:\/\/localhost:\d+/g, "https://morihix-wp.piyushassudani.in") : null;

    // Only upload and attach media header if the template actually expects a media header (or if template lookup failed)
    if (req.file && (!templateFetched || templateRequiresMediaHeader)) {
      if (req.file.mimetype.startsWith("image/")) {
        media_type = "image";
      } else if (req.file.mimetype.startsWith("video/")) {
        media_type = "video";
      } else {
        media_type = "document";
      }

      if (templateRequiresMediaHeader && requiredHeaderFormat && media_type !== requiredHeaderFormat) {
        return res.status(400).json({
          error: `Template "${template_name.trim()}" requires a ${requiredHeaderFormat} header, but a ${media_type} file was uploaded.`,
        });
      }

      media_id = await uploadMediaToMeta(req.file.path, req.file.mimetype);
      if (!media_id) {
        return res.status(500).json({ error: "Failed to upload media to WhatsApp Meta API." });
      }

      try {
        let resourceType = "auto";
        if (media_type === "image") resourceType = "image";
        if (media_type === "video") resourceType = "video";
        media_url = await uploadFileToCloudinary(req.file.path, "wp_automation/campaigns", resourceType);
      } catch (uploadErr) {
        console.warn("Media storage upload skipped, proceeding with Meta ID:", uploadErr.message);
      }
    } else if (incomingMediaUrl) {
      media_type = (req.body.media_type || (requiredHeaderFormat ? requiredHeaderFormat.toLowerCase() : "image"));
    }

    // Fetch distinct members across all chosen contact lists
    const membersResult = await db.query(
      `SELECT DISTINCT c.id, c.phone_number, c.name, c.city
       FROM contact_list_members clm
       JOIN contacts c ON clm.contact_id = c.id
       WHERE clm.list_id = ANY($1::uuid[])`,
      [parsedListIds]
    );

    if (membersResult.rows.length === 0) {
      return res.status(400).json({ error: "Selected contact lists have no recipients or are empty." });
    }

    const campaignResult = await db.query(
      `INSERT INTO campaigns (name, template_name, contact_list_id, media_id, media_type, media_url, total_sent)
       VALUES ($1, $2, $3, $4, $5, $6, 0)
       RETURNING *`,
      [name.trim().slice(0, 255), template_name.trim(), parsedListIds[0], media_id, media_type, media_url]
    );
    const campaign = campaignResult.rows[0];

    const messages = membersResult.rows.map((member) => {
      const bodyParams = [];
      if (paramCount >= 1) {
        bodyParams.push({ type: "text", text: member.name || "Customer" });
      }
      if (paramCount >= 2) {
        bodyParams.push({ type: "text", text: member.city || "Valued Client" });
      }
      for (let i = 2; i < paramCount; i++) {
        bodyParams.push({ type: "text", text: "Update" });
      }

      const sanitizedPhone = member.phone_number ? String(member.phone_number).replace(/\D/g, "") : "";

      return {
        to: sanitizedPhone,
        contactId: member.id,
        bodyParams,
      };
    });

    const io = req.app.get("io");
    await processCampaign(
      messages,
      campaign.id,
      template_name.trim(),
      resolvedLanguageCode,
      io,
      media_id,
      media_type,
      media_url
    );

    // Keep history clean: automatically keep the last 100 campaigns
    db.query(
      `DELETE FROM campaigns 
       WHERE id NOT IN (
         SELECT id FROM campaigns 
         ORDER BY created_at DESC 
         LIMIT 100
       )`
    ).catch(() => {});

    res.status(201).json({
      message: "Campaign launched and queued for delivery",
      campaign: {
        id: campaign.id,
        name: campaign.name,
        template_name: campaign.template_name,
        total_recipients: messages.length,
        created_at: campaign.created_at,
      },
    });
  } catch (err) {
    console.error("❌ Campaign creation error:", err);
    res.status(500).json({ error: "Failed to create and dispatch campaign." });
  }
});

/**
 * GET /api/campaigns
 * List all campaigns with aggregate delivery metrics
 */
router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
        c.*,
        COUNT(m.id) as total_messages,
        COUNT(CASE WHEN m.status = 'delivered' THEN 1 END) as total_delivered,
        COUNT(CASE WHEN m.status = 'read' THEN 1 END) as total_read,
        COUNT(CASE WHEN m.status = 'failed' THEN 1 END) as total_failed
      FROM campaigns c
      LEFT JOIN messages m ON m.campaign_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC`
    );
    const rows = result.rows.map(c => ({
      ...c,
      media_url: c.media_url?.replace(/http:\/\/localhost:\d+/g, "https://morihix-wp.piyushassudani.in") || c.media_url,
    }));
    res.json(rows);
  } catch (err) {
    console.error("❌ List campaigns error:", err);
    res.status(500).json({ error: "Failed to list campaigns." });
  }
});

/**
 * GET /api/campaigns/:id
 * Retrieve details and delivery metrics for a specific campaign
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid campaign ID format." });
    }

    const campaignResult = await db.query(`SELECT * FROM campaigns WHERE id = $1`, [id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const statsResult = await db.query(
      `SELECT
        status,
        COUNT(*) as count
      FROM messages
      WHERE campaign_id = $1
      GROUP BY status`,
      [id]
    );

    const camp = campaignResult.rows[0];
    if (camp && camp.media_url) {
      camp.media_url = camp.media_url.replace(/http:\/\/localhost:\d+/g, "https://morihix-wp.piyushassudani.in");
    }

    res.json({
      ...camp,
      stats: statsResult.rows,
    });
  } catch (err) {
    console.error("❌ Campaign detail error:", err);
    res.status(500).json({ error: "Failed to fetch campaign details." });
  }
});

/**
 * GET /api/campaigns/:id/recipients
 * Retrieve individual recipient delivery statuses
 */
router.get("/:id/recipients", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid campaign ID format." });
    }

    const result = await db.query(
      `SELECT m.id, c.phone_number, c.name, m.status, m.timestamp, m.error_message
       FROM messages m
       JOIN contacts c ON m.contact_id = c.id
       WHERE m.campaign_id = $1
       ORDER BY m.timestamp DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Campaign recipients error:", err);
    res.status(500).json({ error: "Failed to fetch campaign recipient list." });
  }
});

/**
 * GET /api/campaigns/:id/export
 * Export all campaign recipient delivery data to Excel (.xlsx)
 */
router.get("/:id/export", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid campaign ID format." });
    }

    const campaignResult = await db.query(`SELECT * FROM campaigns WHERE id = $1`, [id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    const campaign = campaignResult.rows[0];

    const result = await db.query(
      `SELECT c.name, c.phone_number, m.status, m.error_message, m.timestamp
       FROM messages m
       JOIN contacts c ON m.contact_id = c.id
       WHERE m.campaign_id = $1
       ORDER BY m.timestamp DESC`,
      [id]
    );

    const rows = result.rows.map((r, index) => {
      let derivedStatus = r.status || "Unknown";
      let errorCategory = "None";

      if (r.status === "failed") {
        const err = (r.error_message || "").toLowerCase();
        if (err.includes("undeliverable")) {
          derivedStatus = "Not on WhatsApp";
          errorCategory = "Not on WhatsApp (Undeliverable)";
        } else if (err.includes("ecosystem")) {
          derivedStatus = "Spam / Rate-limit Filtered";
          errorCategory = "Spam / Ecosystem Protection";
        } else {
          derivedStatus = "Failed";
          errorCategory = "Meta API Error";
        }
      } else if (r.status === "read") {
        derivedStatus = "Read";
      } else if (r.status === "delivered") {
        derivedStatus = "Delivered";
      } else if (r.status === "sent") {
        derivedStatus = "Sent";
      }

      return {
        "S.No": index + 1,
        "Recipient Name": r.name || "Unknown",
        "Phone Number": `+${r.phone_number}`,
        "Status": derivedStatus,
        "Error Category": errorCategory,
        "Error Details": r.error_message || "",
        "Sent Date & Time": r.timestamp ? new Date(r.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "",
        "Campaign Name": campaign.name,
        "Template Name": campaign.template_name,
      };
    });

    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!cols"] = [
      { wch: 6 },
      { wch: 22 },
      { wch: 18 },
      { wch: 18 },
      { wch: 28 },
      { wch: 45 },
      { wch: 24 },
      { wch: 22 },
      { wch: 20 },
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Campaign Report");

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const safeFilename = `${(campaign.name || "campaign").replace(/[^a-zA-Z0-9_-]/g, "_")}_Report.xlsx`;

    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buffer);
  } catch (err) {
    console.error("❌ Campaign export error:", err);
    res.status(500).json({ error: "Failed to export campaign data." });
  }
});

/**
 * POST /api/campaigns/:id/retry
 * Resend/retry failed messages for a campaign, optionally filtered by category
 */
router.post("/:id/retry", async (req, res) => {
  try {
    const { id } = req.params;
    const { category, messageIds } = req.body || {};

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid campaign ID format." });
    }

    const campaignResult = await db.query(`SELECT * FROM campaigns WHERE id = $1`, [id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    const campaign = campaignResult.rows[0];

    // Fetch failed messages
    let query = `
      SELECT m.id as message_id, m.contact_id, m.error_message, c.phone_number, c.name, c.city
      FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      WHERE m.campaign_id = $1 AND m.status = 'failed'
    `;
    const params = [id];

    if (Array.isArray(messageIds) && messageIds.length > 0) {
      const validIds = messageIds.filter(isValidUuid);
      if (validIds.length > 0) {
        query += ` AND m.id = ANY($2::uuid[])`;
        params.push(validIds);
      }
    }

    const failedMessagesResult = await db.query(query, params);
    let failedRows = failedMessagesResult.rows;

    // Filter by category if specified
    if (category === "not-on-whatsapp") {
      failedRows = failedRows.filter(r => r.error_message && r.error_message.toLowerCase().includes("undeliverable"));
    } else if (category === "spam-filtered") {
      failedRows = failedRows.filter(r => r.error_message && r.error_message.toLowerCase().includes("ecosystem"));
    } else if (category === "other-failed") {
      failedRows = failedRows.filter(r => {
        const err = (r.error_message || "").toLowerCase();
        return !err.includes("undeliverable") && !err.includes("ecosystem");
      });
    }

    if (failedRows.length === 0) {
      return res.status(400).json({ error: "No matching failed recipients found to retry." });
    }

    // Inspect template to get paramCount and resolvedLanguageCode
    let paramCount = 0;
    let resolvedLanguageCode = "en_US";
    try {
      const templates = await getTemplates();
      const tpl = (templates || []).find((t) => t.name === campaign.template_name?.trim());
      if (tpl) {
        if (tpl.language) resolvedLanguageCode = tpl.language;
        if (tpl.components) {
          const bodyComponent = tpl.components.find((c) => c.type === "BODY");
          if (bodyComponent && bodyComponent.text) {
            const matches = bodyComponent.text.match(/\{\{\d+\}\}/g);
            if (matches) paramCount = matches.length;
          }
        }
      }
    } catch (e) {
      console.warn("Template fetch during retry:", e.message);
    }

    // Remove the old failed message records so fresh records get created
    const idsToDelete = failedRows.map(r => r.message_id);
    await db.query(`DELETE FROM messages WHERE id = ANY($1::uuid[])`, [idsToDelete]);

    const messages = failedRows.map((member) => {
      const bodyParams = [];
      if (paramCount >= 1) bodyParams.push({ type: "text", text: member.name || "Customer" });
      if (paramCount >= 2) bodyParams.push({ type: "text", text: member.city || "Valued Client" });
      for (let i = 2; i < paramCount; i++) bodyParams.push({ type: "text", text: "Update" });

      const sanitizedPhone = member.phone_number ? String(member.phone_number).replace(/\D/g, "") : "";
      return {
        to: sanitizedPhone,
        contactId: member.contact_id,
        bodyParams,
      };
    });

    const io = req.app.get("io");
    await processCampaign(
      messages,
      campaign.id,
      campaign.template_name.trim(),
      resolvedLanguageCode,
      io,
      campaign.media_id,
      campaign.media_type,
      campaign.media_url
    );

    res.json({
      success: true,
      retriedCount: messages.length,
      message: `Resending ${messages.length} messages...`,
    });
  } catch (err) {
    console.error("❌ Retry campaign error:", err);
    res.status(500).json({ error: "Failed to retry campaign messages." });
  }
});

/**
 * DELETE /api/campaigns/:id
 * Delete campaign and associated messages
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid campaign ID format." });
    }

    await db.query("DELETE FROM messages WHERE campaign_id = $1", [id]);
    const result = await db.query("DELETE FROM campaigns WHERE id = $1 RETURNING id", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json({ message: "Campaign deleted successfully" });
  } catch (err) {
    console.error("❌ Campaign deletion error:", err);
    res.status(500).json({ error: "Failed to delete campaign." });
  }
});

module.exports = router;
