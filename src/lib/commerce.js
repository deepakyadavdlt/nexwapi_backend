// lib/commerce.js — WhatsApp Commerce / Meta Catalog sync + messaging helpers
import { prisma } from "./prisma.js";
import { WA } from "../config/whatsapp.js";
import { getEffectiveCreds, assertLiveCreds, sendText, sendList, sendProductList, sendCatalogMessage, sendButtons } from "./whatsappService.js";
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
  try {
    return await prisma.commerceSetting.upsert({
      where: { companyId },
      create: { companyId },
      update: {},
    });
  } catch (e) {
    // Race: two requests upsert/create at once — fetch existing row
    if (e?.code === "P2002") {
      const row = await prisma.commerceSetting.findUnique({ where: { companyId } });
      if (row) return row;
    }
    throw e;
  }
}

export function commerceUserError(e) {
  const msg = String(e?.message || e || "");
  if (/Unique constraint failed/i.test(msg)) return "Commerce settings already saved. Refresh the page.";
  if (/CommerceSetting|CatalogCollection|CommerceOrder|does not exist/i.test(msg)) {
    return "Commerce database is updating. Restart the backend, then refresh this page.";
  }
  if (/Connect WhatsApp first/i.test(msg)) return msg;
  if (/WhatsApp Meta credentials are incomplete/i.test(msg)) return msg;
  return msg.replace(/Invalid `prisma\.[^`]+` invocation:\s*/gi, "").trim() || "Something went wrong";
}

export async function ensureSampleCatalog(companyId) {
  const setting = await getOrCreateCommerceSetting(companyId);
  if (!setting.sandboxMode || setting.catalogId) return setting;

  const productCount = await prisma.product.count({ where: { companyId, source: "sample" } });
  if (productCount === 0) {
    for (const p of SAMPLE_PRODUCTS) {
      const exists = await prisma.product.findFirst({ where: { companyId, retailerId: p.retailerId } });
      if (!exists) {
        await prisma.product.create({
          data: { companyId, ...p, currency: "INR", source: "sample", availability: "in stock" },
        });
      }
    }
  }

  const colCount = await prisma.catalogCollection.count({ where: { companyId } });
  if (colCount === 0) {
    const products = await prisma.product.findMany({ where: { companyId, source: "sample" } });
    const ids = products.map((p) => p.retailerId).filter(Boolean);
    for (let i = 0; i < SAMPLE_COLLECTIONS.length; i++) {
      const c = SAMPLE_COLLECTIONS[i];
      await prisma.catalogCollection.upsert({
        where: { companyId_metaSetId: { companyId, metaSetId: c.metaSetId } },
        create: {
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
        update: {},
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
      await prisma.catalogCollection.upsert({
        where: { companyId_metaSetId: { companyId, metaSetId } },
        create: { companyId, metaSetId, ...payload },
        update: payload,
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
  const setting = await getOrCreateCommerceSetting(companyId);
  await ensureSampleCatalog(companyId);
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
  const subtotal = items.reduce((sum, it) => sum + Number(it.itemPrice || 0) * Number(it.quantity || 1), 0);
  const currency = items[0]?.currency || "INR";
  const pricing = computeOrderTotals(subtotal, setting);

  const order = await prisma.commerceOrder.create({
    data: {
      companyId,
      contactId: contact.id,
      contactPhone: contact.phone || "",
      contactName: contact.name || "",
      waMessageId: waMessageId || null,
      catalogId: orderPayload?.catalog_id || setting.catalogId || "",
      status: setting.autocheckoutEnabled ? "pending_address" : "enquiry",
      orderStatus: "cart_received",
      paymentStatus: "unpaid",
      fulfillmentStatus: "not_scheduled",
      currency,
      totalAmount: String(pricing.total),
      items,
      notes: JSON.stringify({ subtotal: pricing.subtotal, shipping: pricing.shipping, discount: pricing.discount }),
      source: "whatsapp_cart",
    },
  });

  fireOrderWebhook(companyId, "order.cart_received", order).catch(() => {});

  const creds = await getEffectiveCreds(companyId);
  if (setting.autocheckoutEnabled && creds && !creds.incomplete) {
    try {
      const body = fillTemplate(setting.proceedMessage, {
        total_order_value: formatMoney(pricing.total, currency),
        shipping_note: shippingNote(setting, pricing),
        payment_note: paymentNote(setting),
        address: "",
      });
      await sendButtons(contact.phone, body, [
        { id: "ac:yes", title: "Yes" },
        { id: "ac:no", title: "No" },
      ], creds);
      await prisma.contact.update({
        where: { id: contact.id },
        data: {
          attributes: {
            ...(contact.attributes || {}),
            pending_commerce_order_id: order.id,
            commerce_checkout_step: "proceed",
            commerce_checkout_draft: {},
          },
        },
      });
    } catch (e) {
      console.warn("[commerce] autocheckout prompt:", e.message);
    }
  }

  return order;
}

function computeOrderTotals(subtotal, setting) {
  const sub = Number(subtotal) || 0;
  let discount = 0;
  if (setting.discountEnabled && setting.discountType === "percent") {
    discount = (sub * (Number(setting.discountValue) || 0)) / 100;
  } else if (setting.discountEnabled && setting.discountType === "flat") {
    discount = Number(setting.discountValue) || 0;
  }
  discount = Math.min(discount, sub);
  const afterDiscount = Math.max(0, sub - discount);

  let shipping = 0;
  if (setting.shippingMode === "fixed") {
    shipping = Number(setting.shippingAmount) || 0;
  } else if (setting.shippingMode === "threshold") {
    const threshold = Number(setting.freeShippingAbove) || 2000;
    shipping = afterDiscount < threshold ? (Number(setting.shippingAmount) || 0) : 0;
  }

  return {
    subtotal: sub,
    discount,
    shipping,
    total: afterDiscount + shipping,
  };
}

function formatMoney(amount, currency = "INR") {
  const n = Number(amount) || 0;
  if (currency === "INR") return `Rs. ${n.toFixed(n % 1 ? 2 : 0)}`;
  return `${currency} ${n.toFixed(2)}`;
}

function shippingNote(setting, pricing) {
  if (setting.shippingMode === "free" || pricing.shipping === 0) {
    return "We currently deliver for free all over India.";
  }
  if (setting.shippingMode === "threshold") {
    return `We apply a shipping cost of Rs. ${setting.shippingAmount || 0} to orders below Rs. ${setting.freeShippingAbove || 2000}.`;
  }
  return `Shipping cost of Rs. ${setting.shippingAmount || 0} applies.`;
}

function paymentNote(setting) {
  if (setting.paymentMethod === "link") return "Please complete payment using the link we send next.";
  if (setting.paymentMethod === "both") return "You can pay via Cash on Delivery or online payment link.";
  return "We only offer Cash on Delivery.";
}

function fillTemplate(tpl, vars) {
  let out = String(tpl || "");
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v ?? ""));
  }
  return out.replace(/\s+/g, " ").trim();
}

function clearCheckoutAttrs(attrs) {
  const next = { ...(attrs || {}) };
  delete next.pending_commerce_order_id;
  delete next.commerce_checkout_step;
  delete next.commerce_checkout_draft;
  return next;
}

function isYes(text, btnId) {
  if (btnId === "ac:yes" || btnId === "ac:confirm") return true;
  return /^(yes|y|haan|ha|ok|okay|proceed|confirm)$/i.test(String(text || "").trim());
}

function isNo(text, btnId) {
  if (btnId === "ac:no" || btnId === "ac:cancel") return true;
  return /^(no|n|nah|cancel|stop)$/i.test(String(text || "").trim());
}

/**
 * Continue Interakt-style autocheckout:
 * proceed → name → pincode → address → confirm → paid/fulfilled
 */
export async function continueAutocheckout(companyId, contact, text, btnId = null) {
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

  const draft = { ...(attrs.commerce_checkout_draft || {}) };

  async function setStep(nextStep, draftPatch = {}) {
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        attributes: {
          ...attrs,
          pending_commerce_order_id: order.id,
          commerce_checkout_step: nextStep,
          commerce_checkout_draft: { ...draft, ...draftPatch },
        },
      },
    });
  }

  async function cancelFlow() {
    await prisma.commerceOrder.update({
      where: { id: order.id },
      data: {
        status: "cancelled",
        orderStatus: "cancelled",
        fulfillmentStatus: "cancelled",
      },
    });
    fireOrderWebhook(companyId, "order.cancelled", { ...order, orderStatus: "cancelled" }).catch(() => {});
    await sendText(contact.phone, setting.cancelMessage || "No problem! Your cart is saved.", creds);
    await prisma.contact.update({
      where: { id: contact.id },
      data: { attributes: clearCheckoutAttrs(attrs) },
    });
  }

  // Any step: user says No
  if (isNo(text, btnId) && (step === "proceed" || step === "confirm")) {
    await cancelFlow();
    return true;
  }

  if (step === "proceed") {
    if (!isYes(text, btnId)) {
      await sendButtons(contact.phone, "Please reply Yes to continue or No to cancel.", [
        { id: "ac:yes", title: "Yes" },
        { id: "ac:no", title: "No" },
      ], creds);
      return true;
    }
    await sendText(contact.phone, setting.askNameMessage, creds);
    await setStep("name");
    return true;
  }

  if (step === "name") {
    const name = String(text || "").trim();
    if (name.length < 2) {
      await sendText(contact.phone, "Please enter your full name.", creds);
      return true;
    }
    await prisma.commerceOrder.update({
      where: { id: order.id },
      data: { contactName: name },
    });
    await sendText(contact.phone, setting.askPincodeMessage, creds);
    await setStep("pincode", { name });
    return true;
  }

  if (step === "pincode") {
    const pincode = String(text || "").replace(/\s/g, "");
    if (!/^\d{4,10}$/.test(pincode)) {
      await sendText(contact.phone, "Please enter a valid pincode (numbers only).", creds);
      return true;
    }
    await sendText(contact.phone, setting.askAddressMessage, creds);
    await setStep("address", { pincode });
    return true;
  }

  if (step === "address") {
    const street = String(text || "").trim();
    if (street.length < 5) {
      await sendText(contact.phone, "Please enter a complete street address.", creds);
      return true;
    }
    const address = {
      name: draft.name || order.contactName,
      pincode: draft.pincode || "",
      street,
      capturedAt: new Date().toISOString(),
    };
    const addressLine = [address.name, address.street, address.pincode].filter(Boolean).join(", ");
    await prisma.commerceOrder.update({
      where: { id: order.id },
      data: {
        shippingAddress: address,
        status: "pending_payment",
        orderStatus: "on_hold",
        contactName: address.name || order.contactName,
      },
    });

    const body = fillTemplate(setting.confirmOrderMessage, {
      address: addressLine,
      total_order_value: formatMoney(order.totalAmount, order.currency),
      shipping_note: "",
      payment_note: paymentNote(setting),
    });
    await sendButtons(contact.phone, body, [
      { id: "ac:confirm", title: "Yes" },
      { id: "ac:cancel", title: "No" },
    ], creds);
    await setStep("confirm", { street, addressLine });
    return true;
  }

  if (step === "confirm") {
    if (!isYes(text, btnId)) {
      await sendButtons(contact.phone, "Please reply Yes to confirm or No to cancel.", [
        { id: "ac:confirm", title: "Yes" },
        { id: "ac:cancel", title: "No" },
      ], creds);
      return true;
    }

    const method = setting.paymentMethod || "cod";
    if (method === "link" || method === "both") {
      let link = setting.paymentLinkBase || "";
      if (link) {
        link = link.includes("?") ? `${link}&order=${order.id}` : `${link}?order=${order.id}`;
      }
      if (link) {
        await prisma.commerceOrder.update({
          where: { id: order.id },
          data: { paymentLink: link, status: method === "link" ? "pending_payment" : "pending_payment" },
        });
        await sendText(
          contact.phone,
          `${setting.paymentPrompt}\n\n${link}\n\nOrder #${order.id.slice(-6).toUpperCase()} · ${formatMoney(order.totalAmount, order.currency)}`,
          creds
        );
        if (method === "link") {
          await setStep("await_payment");
          return true;
        }
      }
    }

    // COD (default) or both after sending link
    const confirmed = await prisma.commerceOrder.update({
      where: { id: order.id },
      data: {
        status: "paid",
        orderStatus: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "pending",
        notes: `${order.notes || ""}\npayment=cod`,
      },
    });
    fireOrderWebhook(companyId, "order.confirmed", confirmed).catch(() => {});
    await sendText(
      contact.phone,
      setting.orderConfirmMessage || `Your order #${order.id.slice(-6).toUpperCase()} is confirmed! We will update you when it ships.`,
      creds
    );
    await prisma.contact.update({
      where: { id: contact.id },
      data: { attributes: clearCheckoutAttrs(attrs) },
    });
    return true;
  }

  if (step === "await_payment") {
    const paid = /paid|done|complete|success|upi|txn/i.test(text || "");
    if (paid) {
      const confirmed = await prisma.commerceOrder.update({
        where: { id: order.id },
        data: {
          status: "paid",
          orderStatus: "confirmed",
          paymentStatus: "paid",
          fulfillmentStatus: "pending",
          notes: text,
        },
      });
      fireOrderWebhook(companyId, "order.confirmed", confirmed).catch(() => {});
      await sendText(contact.phone, setting.orderConfirmMessage, creds);
      await prisma.contact.update({
        where: { id: contact.id },
        data: { attributes: clearCheckoutAttrs(attrs) },
      });
      return true;
    }
    await sendText(contact.phone, "Reply \"paid\" after completing payment, or open the payment link again from above.", creds);
    return true;
  }

  return false;
}

export function autocheckoutReadySteps(setting) {
  const shippingOk = Boolean(setting.shippingConfirmed);
  const discountsOk = Boolean(setting.discountsConfirmed);
  const paymentOk = Boolean(setting.paymentConfirmed);
  const remaining = [shippingOk, discountsOk, paymentOk].filter((x) => !x).length;
  return {
    shippingOk,
    discountsOk,
    paymentOk,
    remaining,
    canGoLive: shippingOk && discountsOk && paymentOk,
    isLive: Boolean(setting.autocheckoutEnabled),
  };
}

export async function checkoutBotOverview(companyId) {
  const setting = await getOrCreateCommerceSetting(companyId);
  const [orderCount, recentOrders, productCount] = await Promise.all([
    prisma.commerceOrder.count({ where: { companyId } }),
    prisma.commerceOrder.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.product.count({ where: { companyId } }),
  ]);
  const ready = autocheckoutReadySteps(setting);
  const sampleTotal = computeOrderTotals(1000, setting);

  return {
    setting: {
      ...setting,
      connectedAt: setting.connectedAt?.getTime?.() || null,
      lastSyncAt: setting.lastSyncAt?.getTime?.() || null,
      createdAt: setting.createdAt?.getTime?.() || null,
      updatedAt: setting.updatedAt?.getTime?.() || null,
    },
    ready,
    catalogConnected: Boolean(setting.catalogId && !setting.sandboxMode),
    productCount,
    orderCount,
    recentOrders: recentOrders.map((o) => serializeCommerceOrder(o)),
    preview: {
      shippingNote: shippingNote(setting, sampleTotal),
      sampleTotal: formatMoney(sampleTotal.total, "INR"),
      paymentNote: paymentNote(setting),
      proceedMessage: fillTemplate(setting.proceedMessage, {
        total_order_value: formatMoney(sampleTotal.total, "INR"),
        shipping_note: shippingNote(setting, sampleTotal),
        payment_note: paymentNote(setting),
        address: "",
      }),
    },
  };
}

export function serializeCommerceOrder(o) {
  const items = Array.isArray(o.items) ? o.items : [];
  const details = items
    .map((it) => `${it.retailerId || "item"} × ${it.quantity || 1}`)
    .join(", ");
  return {
    ...o,
    items,
    orderStatus: o.orderStatus || deriveOrderStatus(o.status),
    paymentStatus: o.paymentStatus || derivePaymentStatus(o.status),
    fulfillmentStatus: o.fulfillmentStatus || deriveFulfillmentStatus(o.status),
    orderDetails: details || "—",
    cartValue: `${o.currency || "INR"} ${o.totalAmount || "0"}`,
    createdAt: o.createdAt instanceof Date ? o.createdAt.getTime() : o.createdAt,
    updatedAt: o.updatedAt instanceof Date ? o.updatedAt.getTime() : o.updatedAt,
  };
}

function deriveOrderStatus(status) {
  if (status === "cancelled") return "cancelled";
  if (status === "paid" || status === "fulfilled") return "confirmed";
  if (status === "pending_payment" || status === "pending_address") return "on_hold";
  return "cart_received";
}

function derivePaymentStatus(status) {
  if (status === "paid" || status === "fulfilled") return "paid";
  return "unpaid";
}

function deriveFulfillmentStatus(status) {
  if (status === "cancelled") return "cancelled";
  if (status === "fulfilled") return "delivered";
  if (status === "paid") return "pending";
  return "not_scheduled";
}

export async function listCommerceOrders(companyId, query = {}) {
  const where = { companyId };
  const orderStatus = query.orderStatus ? String(query.orderStatus) : "";
  const paymentStatus = query.paymentStatus ? String(query.paymentStatus) : "";
  const fulfillmentStatus = query.fulfillmentStatus ? String(query.fulfillmentStatus) : "";
  const legacyStatus = query.status ? String(query.status) : "";

  if (orderStatus) where.orderStatus = orderStatus;
  if (paymentStatus) where.paymentStatus = paymentStatus;
  if (fulfillmentStatus) where.fulfillmentStatus = fulfillmentStatus;
  if (legacyStatus) where.status = legacyStatus;

  const from = query.from ? new Date(String(query.from)) : null;
  const to = query.to ? new Date(String(query.to)) : null;
  const range = String(query.range || "").toLowerCase();

  if (range && range !== "all") {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (range === "today") {
      where.createdAt = { gte: start };
    } else if (range === "yesterday") {
      const y = new Date(start);
      y.setDate(y.getDate() - 1);
      where.createdAt = { gte: y, lt: start };
    } else if (range === "7d") {
      const d = new Date(start);
      d.setDate(d.getDate() - 6);
      where.createdAt = { gte: d };
    } else if (range === "30d") {
      const d = new Date(start);
      d.setDate(d.getDate() - 29);
      where.createdAt = { gte: d };
    }
  } else if (from || to) {
    where.createdAt = {};
    if (from && !Number.isNaN(from.getTime())) where.createdAt.gte = from;
    if (to && !Number.isNaN(to.getTime())) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  const orders = await prisma.commerceOrder.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(Number(query.limit) || 200, 500),
  });
  return orders.map(serializeCommerceOrder);
}

export async function orderPanelMeta(companyId) {
  const [setting, orderCount] = await Promise.all([
    getOrCreateCommerceSetting(companyId),
    prisma.commerceOrder.count({ where: { companyId } }),
  ]);
  const companySetting = await prisma.setting.findUnique({ where: { companyId } }).catch(() => null);
  return {
    catalogConnected: Boolean(setting.catalogId && !setting.sandboxMode),
    checkoutLive: Boolean(setting.autocheckoutEnabled),
    orderCount,
    webhookUrl: companySetting?.webhookUrl || "",
    sandboxMode: Boolean(setting.sandboxMode),
  };
}

export function ordersToCsv(orders) {
  const headers = [
    "Customer Name", "Phone", "Cart Date", "Order ID", "Cart Value",
    "Order Details", "Order Status", "Payment Status", "Fulfillment Status",
  ];
  const lines = [headers.join(",")];
  for (const o of orders) {
    const row = [
      o.contactName, o.contactPhone,
      o.createdAt ? new Date(o.createdAt).toISOString() : "",
      o.id, o.cartValue || `${o.currency} ${o.totalAmount}`,
      o.orderDetails, o.orderStatus, o.paymentStatus, o.fulfillmentStatus,
    ].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`);
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

async function fireOrderWebhook(companyId, event, order) {
  try {
    const s = await prisma.setting.findUnique({ where: { companyId } });
    const url = String(s?.webhookUrl || "").trim();
    if (!url) return;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        type: "whatsapp_carts_and_orders",
        companyId,
        order: serializeCommerceOrder(order),
        at: Date.now(),
      }),
    });
  } catch (e) {
    console.warn("[commerce] order webhook:", e.message);
  }
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
