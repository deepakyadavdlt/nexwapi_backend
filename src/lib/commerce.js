// lib/commerce.js — WhatsApp Commerce / Meta Catalog sync + messaging helpers
import { prisma } from "./prisma.js";
import { WA } from "../config/whatsapp.js";
import { getEffectiveCreds, assertLiveCreds, sendText, sendList, sendProductList, sendCatalogMessage } from "./whatsappService.js";
import { nanoid } from "nanoid";

const SAMPLE_PRODUCTS = [
  { name: "Classic Tee", price: "799", description: "Soft cotton daily-wear tee", imageUrl: "", retailerId: "sample_tee_1" },
  { name: "Hero Hoodie", price: "1499", description: "Fleece hoodie for cooler days", imageUrl: "", retailerId: "sample_hoodie_1" },
  { name: "Denim Jacket", price: "2499", description: "Light wash denim jacket", imageUrl: "", retailerId: "sample_jacket_1" },
  { name: "Canvas Tote", price: "499", description: "Eco canvas tote bag", imageUrl: "", retailerId: "sample_tote_1" },
];

const SAMPLE_COLLECTIONS = [
  { name: "Smart Daily Wear", metaSetId: "sample_daily", bodyText: "Check out our Smart Daily Wear products here! 😊" },
  { name: "Superhero Tees", metaSetId: "sample_hero", bodyText: "Pick your favourite Superhero Tee!" },
  { name: "Trending Westernwear", metaSetId: "sample_west", bodyText: "Trending western styles for you." },
];

export function partnerBusinessId() {
  return String(process.env.META_PARTNER_BUSINESS_ID || process.env.WHATSAPP_BUSINESS_ID || "").trim();
}

function graphVersion() {
  return WA.version || "v22.0";
}

async function graphGet(path, accessToken, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://graph.facebook.com/${graphVersion()}/${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.error_user_msg || data?.error?.message || JSON.stringify(data);
    const err = new Error(msg);
    err.status = res.status;
    err.meta = data?.error;
    throw err;
  }
  return data;
}

async function graphPost(path, accessToken, body) {
  const url = `https://graph.facebook.com/${graphVersion()}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.error_user_msg || data?.error?.message || JSON.stringify(data);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function getOrCreateCommerceSetting(companyId) {
  let row = await prisma.commerceSetting.findUnique({ where: { companyId } });
  if (!row) {
    row = await prisma.commerceSetting.create({
      data: { id: `cs_${nanoid(12)}`, companyId },
    });
  }
  return row;
}

export async function ensureSampleCatalog(companyId) {
  const setting = await getOrCreateCommerceSetting(companyId);
  if (!setting.sandboxMode || setting.catalogId) return setting;

  const productCount = await prisma.product.count({ where: { companyId, source: "sample" } });
  if (productCount === 0) {
    for (const p of SAMPLE_PRODUCTS) {
      await prisma.product.create({
        data: { companyId, ...p, currency: "INR", source: "sample", availability: "in stock" },
      });
    }
  }

  const colCount = await prisma.catalogCollection.count({ where: { companyId } });
  if (colCount === 0) {
    const products = await prisma.product.findMany({ where: { companyId, source: "sample" } });
    const ids = products.map((p) => p.retailerId).filter(Boolean);
    for (let i = 0; i < SAMPLE_COLLECTIONS.length; i++) {
      const c = SAMPLE_COLLECTIONS[i];
      await prisma.catalogCollection.create({
        data: {
          companyId,
          metaSetId: c.metaSetId,
          name: c.name,
          includeInTop10: true,
          headerText: c.name,
          bodyText: c.bodyText,
          productCount: ids.length,
          productRetailerIds: ids.slice(0, 10),
          sortOrder: i,
        },
      });
    }
  }
  return setting;
}

export async function listOwnedCatalogs(creds) {
  assertLiveCreds(creds);
  if (!creds?.wabaId || !creds?.accessToken) return [];
  try {
    const data = await graphGet(`${creds.wabaId}/product_catalogs`, creds.accessToken, {
      fields: "id,name,product_count",
      limit: "50",
    });
    return data.data || [];
  } catch (e) {
    console.warn("[commerce] list catalogs:", e.message);
    return [];
  }
}

export async function verifyCatalog(catalogId, accessToken) {
  const data = await graphGet(catalogId, accessToken, { fields: "id,name,product_count,vertical" });
  return data;
}

export async function fetchProductSets(catalogId, accessToken) {
  const data = await graphGet(`${catalogId}/product_sets`, accessToken, {
    fields: "id,name,product_count,filter",
    limit: "100",
  });
  return data.data || [];
}

export async function fetchCatalogProducts(catalogId, accessToken, { limit = 100 } = {}) {
  const data = await graphGet(`${catalogId}/products`, accessToken, {
    fields: "id,retailer_id,name,description,price,currency,image_url,availability,url",
    limit: String(limit),
  });
  return data.data || [];
}

export async function fetchSetProducts(setId, accessToken, { limit = 30 } = {}) {
  const data = await graphGet(`${setId}/products`, accessToken, {
    fields: "id,retailer_id,name,price,currency,image_url",
    limit: String(limit),
  });
  return data.data || [];
}

/** Connect a Meta catalog ID to this company and optionally link to WABA. */
export async function connectCatalog(companyId, catalogId) {
  const creds = await getEffectiveCreds(companyId);
  assertLiveCreds(creds);
  if (!creds?.accessToken) throw Object.assign(new Error("Connect WhatsApp first"), { status: 400 });

  const id = String(catalogId || "").trim();
  if (!id) throw Object.assign(new Error("Facebook Catalog ID required"), { status: 400 });

  const meta = await verifyCatalog(id, creds.accessToken);
  const setting = await getOrCreateCommerceSetting(companyId);

  // Best-effort: associate catalog with WABA (ignored if already linked / permission missing)
  if (creds.wabaId) {
    try {
      await graphPost(`${creds.wabaId}/product_catalogs`, creds.accessToken, { catalog_id: id });
    } catch (e) {
      console.warn("[commerce] WABA catalog link (optional):", e.message);
    }
  }

  const updated = await prisma.commerceSetting.update({
    where: { companyId },
    data: {
      catalogId: meta.id || id,
      catalogName: meta.name || "",
      connectedAt: new Date(),
      sandboxMode: false,
    },
  });

  await syncCatalog(companyId);
  return updated;
}

export async function syncCatalog(companyId) {
  const setting = await getOrCreateCommerceSetting(companyId);
  const creds = await getEffectiveCreds(companyId);

  if (!setting.catalogId || setting.sandboxMode) {
    await ensureSampleCatalog(companyId);
    return {
      ok: true,
      sandbox: true,
      products: await prisma.product.count({ where: { companyId } }),
      collections: await prisma.catalogCollection.count({ where: { companyId } }),
      lastSyncAt: setting.lastSyncAt,
    };
  }

  assertLiveCreds(creds);
  if (!creds?.accessToken) throw Object.assign(new Error("WhatsApp not connected"), { status: 400 });

  const [sets, products] = await Promise.all([
    fetchProductSets(setting.catalogId, creds.accessToken),
    fetchCatalogProducts(setting.catalogId, creds.accessToken, { limit: 200 }),
  ]);

  // Upsert products from Meta
  const seenRetailers = new Set();
  for (const p of products) {
    const retailerId = String(p.retailer_id || p.id || "").trim();
    if (!retailerId) continue;
    seenRetailers.add(retailerId);
    const price = p.price != null ? String(p.price) : "";
    const existing = await prisma.product.findFirst({
      where: { companyId, retailerId },
    });
    const data = {
      name: p.name || "Product",
      price,
      description: p.description || "",
      imageUrl: p.image_url || "",
      currency: p.currency || "INR",
      availability: p.availability || "in stock",
      source: "meta",
      metaProductId: String(p.id || ""),
      retailerId,
    };
    if (existing) {
      await prisma.product.update({ where: { id: existing.id }, data });
    } else {
      await prisma.product.create({ data: { companyId, ...data } });
    }
  }

  // Remove stale sample products when live catalog syncs
  await prisma.product.deleteMany({ where: { companyId, source: "sample" } });

  // Collections / product sets
  const existingCols = await prisma.catalogCollection.findMany({ where: { companyId } });
  const byMeta = new Map(existingCols.map((c) => [c.metaSetId, c]));
  const keepMetaIds = new Set();

  for (let i = 0; i < sets.length; i++) {
    const s = sets[i];
    const metaSetId = String(s.id);
    keepMetaIds.add(metaSetId);
    let retailerIds = [];
    try {
      const setProducts = await fetchSetProducts(metaSetId, creds.accessToken, { limit: 30 });
      retailerIds = setProducts.map((p) => String(p.retailer_id || p.id)).filter(Boolean);
    } catch {
      retailerIds = [];
    }
    const prev = byMeta.get(metaSetId);
    const payload = {
      name: s.name || "Collection",
      productCount: Number(s.product_count || retailerIds.length || 0),
      productRetailerIds: retailerIds,
      sortOrder: i,
      includeInTop10: prev ? prev.includeInTop10 : i < 10,
      headerText: prev?.headerText || s.name || "",
      bodyText: prev?.bodyText || `Check out our ${s.name || "collection"} products here! 😊`,
      footerText: prev?.footerText || "",
      imageUrl: prev?.imageUrl || "",
    };
    if (prev) {
      await prisma.catalogCollection.update({ where: { id: prev.id }, data: payload });
    } else {
      await prisma.catalogCollection.create({
        data: { companyId, metaSetId, ...payload },
      });
    }
  }

  // Drop sample collections / orphaned sample sets
  await prisma.catalogCollection.deleteMany({
    where: {
      companyId,
      OR: [
        { metaSetId: { startsWith: "sample_" } },
        ...(keepMetaIds.size ? [{ AND: [{ metaSetId: { not: "" } }, { metaSetId: { notIn: [...keepMetaIds] } }] }] : []),
      ],
    },
  });

  const updated = await prisma.commerceSetting.update({
    where: { companyId },
    data: {
      lastSyncAt: new Date(),
      catalogName: setting.catalogName || "",
      sandboxMode: false,
    },
  });

  return {
    ok: true,
    sandbox: false,
    products: await prisma.product.count({ where: { companyId } }),
    collections: await prisma.catalogCollection.count({ where: { companyId } }),
    lastSyncAt: updated.lastSyncAt,
  };
}

export async function commerceOverview(companyId) {
  await ensureSampleCatalog(companyId);
  const setting = await getOrCreateCommerceSetting(companyId);
  const [collections, products, orders, wa, flows] = await Promise.all([
    prisma.catalogCollection.findMany({ where: { companyId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.product.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.commerceOrder.count({ where: { companyId } }),
    prisma.whatsAppAccount.findFirst({ where: { companyId, isConnected: true }, orderBy: { isDefault: "desc" } }),
    prisma.flow.findMany({
      where: { companyId },
      select: { id: true, name: true, enabled: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  let ownedCatalogs = [];
  try {
    const creds = await getEffectiveCreds(companyId);
    if (creds?.accessToken && !creds.incomplete) {
      ownedCatalogs = await listOwnedCatalogs(creds);
    }
  } catch {
    ownedCatalogs = [];
  }

  return {
    setting: {
      ...setting,
      connectedAt: setting.connectedAt?.getTime?.() || null,
      lastSyncAt: setting.lastSyncAt?.getTime?.() || null,
      createdAt: setting.createdAt?.getTime?.() || null,
      updatedAt: setting.updatedAt?.getTime?.() || null,
    },
    collections: collections.map((c) => ({
      ...c,
      productRetailerIds: Array.isArray(c.productRetailerIds) ? c.productRetailerIds : [],
      createdAt: c.createdAt.getTime(),
      updatedAt: c.updatedAt.getTime(),
    })),
    products: products.map((p) => ({ ...p, createdAt: p.createdAt.getTime() })),
    orderCount: orders,
    whatsappConnected: Boolean(wa?.isConnected && wa?.phoneNumberId && wa?.accessToken),
    phoneNumber: wa?.displayPhoneNumber || wa?.phoneNumber || null,
    partnerBusinessId: partnerBusinessId(),
    ownedCatalogs,
    flows,
    steps: {
      productsAdded: products.length > 0,
      catalogConnected: Boolean(setting.catalogId && !setting.sandboxMode),
      collectionsConfigured: collections.some((c) => c.includeInTop10),
      campaignsReady: setting.catalogInCampaigns,
      autoRepliesReady: setting.catalogInAutoReplies,
      autocheckoutReady: setting.autocheckoutEnabled,
    },
  };
}

/** Send Top-N collections as a WhatsApp list message. */
export async function sendCollectionsList(companyId, toPhone) {
  const setting = await getOrCreateCommerceSetting(companyId);
  const cols = await prisma.catalogCollection.findMany({
    where: { companyId, includeInTop10: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    take: 10,
  });
  if (!cols.length) throw Object.assign(new Error("No collections to send. Sync your FB catalog first."), { status: 400 });

  const creds = await getEffectiveCreds(companyId);
  assertLiveCreds(creds);

  const rows = cols.map((c) => ({
    id: `col:${c.id}`,
    title: String(c.name).slice(0, 24),
    description: `${c.productCount || 0} items`.slice(0, 72),
  }));

  return sendList(
    toPhone,
    setting.collectionsBody || "Hey there, check out our top product collections",
    setting.collectionsButton || "View Collections",
    [{ title: "Collections", rows }],
    creds
  );
}

/** After customer picks a collection, send Meta product_list catalog message. */
export async function sendCollectionCatalog(companyId, toPhone, collectionId) {
  const col = await prisma.catalogCollection.findFirst({
    where: { id: collectionId, companyId },
  });
  if (!col) throw Object.assign(new Error("Collection not found"), { status: 404 });

  const setting = await getOrCreateCommerceSetting(companyId);
  const creds = await getEffectiveCreds(companyId);
  assertLiveCreds(creds);

  const retailerIds = (Array.isArray(col.productRetailerIds) ? col.productRetailerIds : []).slice(0, 30);
  if (!retailerIds.length && setting.sandboxMode) {
    // Sandbox: fall back to text list of sample products
    const products = await prisma.product.findMany({ where: { companyId }, take: 10 });
    const lines = products.map((p) => `• ${p.name}${p.price ? ` — ₹${p.price}` : ""}`).join("\n");
    return sendText(
      toPhone,
      `${col.bodyText || col.name}\n\n${lines || "No products yet."}\n\n(Connect your FB Catalog for real WhatsApp Catalog messages.)`,
      creds
    );
  }

  if (!setting.catalogId || !retailerIds.length) {
    throw Object.assign(new Error("Collection has no products. Sync catalog again."), { status: 400 });
  }

  return sendProductList(
    toPhone,
    {
      catalogId: setting.catalogId,
      header: col.headerText || col.name,
      body: col.bodyText || `Check out our ${col.name} products here! 😊`,
      footer: col.footerText || undefined,
      sections: [
        {
          title: String(col.name).slice(0, 24),
          product_items: retailerIds.map((id) => ({ product_retailer_id: id })),
        },
      ],
    },
    creds
  );
}

export async function sendFullCatalog(companyId, toPhone) {
  const setting = await getOrCreateCommerceSetting(companyId);
  const creds = await getEffectiveCreds(companyId);
  assertLiveCreds(creds);
  if (!setting.catalogId || setting.sandboxMode) {
    return sendCollectionsList(companyId, toPhone);
  }
  return sendCatalogMessage(toPhone, {
    catalogId: setting.catalogId,
    body: setting.collectionsBody || "Browse our full catalog",
    footer: "Nexwapi Commerce",
  }, creds);
}

/** Handle inbound WhatsApp order (cart) message → CommerceOrder + autocheckout. */
export async function handleInboundOrder(companyId, contact, orderPayload, waMessageId) {
  const setting = await getOrCreateCommerceSetting(companyId);
  const items = (orderPayload?.product_items || []).map((it) => ({
    retailerId: it.product_retailer_id,
    quantity: it.quantity || 1,
    itemPrice: it.item_price,
    currency: it.currency || "INR",
  }));
  const total = items.reduce((sum, it) => sum + Number(it.itemPrice || 0) * Number(it.quantity || 1), 0);
  const currency = items[0]?.currency || "INR";

  const order = await prisma.commerceOrder.create({
    data: {
      companyId,
      contactId: contact.id,
      contactPhone: contact.phone || "",
      contactName: contact.name || "",
      waMessageId: waMessageId || null,
      catalogId: orderPayload?.catalog_id || setting.catalogId || "",
      status: setting.autocheckoutEnabled ? "pending_address" : "enquiry",
      currency,
      totalAmount: String(total),
      items,
      source: "whatsapp_cart",
    },
  });

  const creds = await getEffectiveCreds(companyId);
  if (setting.autocheckoutEnabled && creds && !creds.incomplete) {
    try {
      await sendText(contact.phone, setting.shippingPrompt, creds);
      await prisma.contact.update({
        where: { id: contact.id },
        data: {
          attributes: {
            ...(contact.attributes || {}),
            pending_commerce_order_id: order.id,
            commerce_checkout_step: "address",
          },
        },
      });
    } catch (e) {
      console.warn("[commerce] autocheckout prompt:", e.message);
    }
  }

  return order;
}

/** Continue autocheckout when customer replies with address / confirmation. */
export async function continueAutocheckout(companyId, contact, text) {
  const attrs = contact.attributes || {};
  const orderId = attrs.pending_commerce_order_id;
  const step = attrs.commerce_checkout_step;
  if (!orderId || !step) return false;

  const setting = await getOrCreateCommerceSetting(companyId);
  if (!setting.autocheckoutEnabled) return false;

  const order = await prisma.commerceOrder.findFirst({ where: { id: orderId, companyId } });
  if (!order) return false;

  const creds = await getEffectiveCreds(companyId);
  if (!creds || creds.incomplete) return false;

  if (step === "address") {
    await prisma.commerceOrder.update({
      where: { id: order.id },
      data: {
        shippingAddress: { raw: text, capturedAt: new Date().toISOString() },
        status: "pending_payment",
      },
    });
    let link = setting.paymentLinkBase || "";
    if (link) {
      link = link.includes("?") ? `${link}&order=${order.id}` : `${link}?order=${order.id}`;
    }
    const msg = link
      ? `${setting.paymentPrompt}\n\n${link}`
      : `${setting.paymentPrompt}\n\nOrder #${order.id.slice(-6).toUpperCase()} · ${order.currency} ${order.totalAmount}\n(Add a payment link in Commerce Settings → Autocheckout.)`;
    await sendText(contact.phone, msg, creds);
    if (link) {
      await prisma.commerceOrder.update({ where: { id: order.id }, data: { paymentLink: link } });
    }
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        attributes: { ...attrs, commerce_checkout_step: "payment", pending_commerce_order_id: order.id },
      },
    });
    return true;
  }

  if (step === "payment") {
    const paid = /paid|done|complete|success|upi|txn/i.test(text || "");
    if (paid) {
      await prisma.commerceOrder.update({
        where: { id: order.id },
        data: { status: "paid", notes: text },
      });
      await sendText(contact.phone, setting.orderConfirmMessage, creds);
      const nextAttrs = { ...attrs };
      delete nextAttrs.pending_commerce_order_id;
      delete nextAttrs.commerce_checkout_step;
      await prisma.contact.update({ where: { id: contact.id }, data: { attributes: nextAttrs } });
      return true;
    }
  }

  return false;
}

export async function parseProductsCsv(csvText) {
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const idx = (names) => headers.findIndex((h) => names.includes(h));
  const iName = idx(["name", "title", "product_name"]);
  const iPrice = idx(["price", "sale_price", "amount"]);
  const iDesc = idx(["description", "desc", "body"]);
  const iImage = idx(["image", "image_url", "imageurl", "picture"]);
  const iRetailer = idx(["retailer_id", "id", "sku", "product_id"]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].match(/("([^"]|"")*"|[^,]*)/g)?.map((c) => c.replace(/^"|"$/g, "").replace(/""/g, '"').trim()) || [];
    const name = iName >= 0 ? cols[iName] : cols[0];
    if (!name) continue;
    out.push({
      name,
      price: iPrice >= 0 ? cols[iPrice] || "" : "",
      description: iDesc >= 0 ? cols[iDesc] || "" : "",
      imageUrl: iImage >= 0 ? cols[iImage] || "" : "",
      retailerId: iRetailer >= 0 ? cols[iRetailer] || `csv_${nanoid(8)}` : `csv_${nanoid(8)}`,
      source: "csv",
    });
  }
  return out;
}
