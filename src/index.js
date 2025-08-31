// server.js (or src/index.js)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import fetch from 'node-fetch'; // make sure installed: npm install node-fetch
import { Client, Databases, ID, Query } from 'node-appwrite';

const app = express();
app.use(cors());
app.use(morgan('dev'));

app.use(express.json({ limit: '1mb' }));



/* ----------------------------- Razorpay client ----------------------------- */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* --------------------------- Appwrite server client ------------------------ */
const awClient = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const db = new Databases(awClient);
const DB_ID = process.env.APPWRITE_DATABASE_ID;
const ORDERS = process.env.APPWRITE_ORDERS_COLLECTION_ID;
const RESTAURANTS = process.env.APPWRITE_RESTAURANTS_COLLECTION_ID;
const DRIVERS = process.env.APPWRITE_DRIVERS_COLLECTION_ID;

/* ----------------------------- Public base URL ----------------------------- */
const BASE = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
if (!BASE || !/^https?:\/\//i.test(BASE)) {
  console.warn('[WARN] PUBLIC_BASE_URL is missing/invalid. Example: https://your-api.example.com');
}

/* --------------------------------- Health --------------------------------- */
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'payments-service', env: process.env.NODE_ENV || 'dev' });
});

/* --------------------------------------------------------------------------
   Razorpay Webhook
-------------------------------------------------------------------------- */
app.post('/api/razorpay/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    if (secret) {
      const sig = req.headers['x-razorpay-signature'] || '';
      const raw = req.body.toString('utf8');
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      if (expected !== sig) return res.status(400).send('Invalid signature');
    }

    const evt = JSON.parse(req.body.toString('utf8'));

    if (evt?.event === 'payment_link.paid') {
      const notesRef = evt?.payload?.payment_link?.entity?.notes?.referenceId;
      if (notesRef) {
        await db.updateDocument(DB_ID, ORDERS, notesRef, {
          paymentStatus: 'paid',
          status: 'placed',
        }).catch(e => console.warn('[Webhook] update failed', e?.message));
      }
      return res.json({ ok: true });
    }

    if (evt?.event === 'payment.captured') {
      const orderId = evt?.payload?.payment?.entity?.notes?.referenceId;
      if (orderId) {
        await db.updateDocument(DB_ID, ORDERS, orderId, {
          paymentStatus: 'paid',
          status: 'placed',
        }).catch(e => console.warn('[Webhook] captured update failed', e?.message));
      }
      return res.json({ ok: true });
    }

    if (evt?.event === 'payment.failed') {
      const orderId = evt?.payload?.payment?.entity?.notes?.referenceId;
      if (orderId) {
        await db.updateDocument(DB_ID, ORDERS, orderId, {
          paymentStatus: 'failed',
          status: 'canceled',
        }).catch(e => console.warn('[Webhook] failed update', e?.message));
      }
      return res.json({ ok: true });
    }

    return res.json({ ok: true, ignored: evt?.event || 'unknown' });
  } catch (e) {
    console.error('webhook error:', e?.message || e);
    return res.status(500).send('webhook_error');
  }
});

// Compatibility route for older frontend clients
// Compatibility route for old frontend, DO NOT create order here
app.post('/api/payments/create-link', async (req, res) => {
  try {
    const { referenceId, amount, name } = req.body;
    if (!referenceId || !amount) {
      return res.status(400).json({ error: "missing_required_fields" });
    }

    const paymentPayload = {
      amount: Math.round(Number(amount) * 100),
      currency: "INR",
      accept_partial: false,
      reference_id: `${referenceId}-${Date.now()}`,
      description: `Foodie order ${referenceId}`,
      customer: { name: name || "Foodie Customer" },
      notify: { sms: false, email: false },
      reminder_enable: true,
      callback_url: `${BASE}/rzp/callback?ref=${encodeURIComponent(referenceId)}`,
      callback_method: "get",
      notes: { referenceId },
    };

    const link = await razorpay.paymentLink.create(paymentPayload);
    return res.json({ ok: true, payment: link });
  } catch (err) {
    console.error("⚠️ create-link error:", err?.message);
    return res.status(500).json({ error: "upi_create_link_failed" });
  }
});


/* ------------------------------------------------------------------
   Create Order (COD or UPI) → auto-create driver doc & start simulator
------------------------------------------------------------------ */
app.post('/api/orders/create', async (req, res) => {
  try {
      console.log("🛒 Incoming raw keys:", Object.keys(req.body));
    console.log("🛒 Full raw body JSON:", JSON.stringify(req.body, null, 2));

    const {
      restaurantId,
      restaurantName,
      items,
      subTotal,
      platformFee,
      deliveryFee,
      gst,
      discount,
      total,
      address,
      paymentMethod,
      userId,
    } = req.body;

    // ✅ Correct validation
    if (!restaurantId || !Array.isArray(items) || items.length === 0 || !total || !paymentMethod || !userId) {
      console.error("❌ Validation failed:", {
        restaurantId,
        userId,
        paymentMethod,
        itemsType: typeof items,
        itemsLength: Array.isArray(items) ? items.length : "not array",
        total,
      });
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // ✅ Sanitize coordinates
    let destLat = null, destLng = null;
    if (address) {
      if (typeof address.lat === "number" && !isNaN(address.lat)) destLat = Number(address.lat);
      if (typeof address.lng === "number" && !isNaN(address.lng)) destLng = Number(address.lng);
    }
    if (destLat === null || destLng === null) {
      console.warn(`[WARN] No valid lat/lng in address. Fallback 0,0`);
      destLat = 0;
      destLng = 0;
    }

    // 1) Create order doc
    const orderDoc = await db.createDocument(DB_ID, ORDERS, ID.unique(), {
      userId,
      restaurantId,
      restaurantName,
      items: JSON.stringify(items),          // ✅ stringify array
      subTotal,
      platformFee,
      deliveryFee,
      gst,
      discount,
      total,
      address: JSON.stringify(address || {}), // ✅ stringify address
      paymentMethod,
      paymentStatus: "pending",
      status: "placed",
    });

    // 2) Get restaurant (start point)
    const rest = await db.getDocument(DB_ID, RESTAURANTS, restaurantId);

    // 3) Create driver doc
    const driverDoc = await db.createDocument(DB_ID, DRIVERS, ID.unique(), {
      orderId: orderDoc.$id,
      lat: Number(rest.lat),
      lng: Number(rest.lng),
      destLat,
      destLng,
      status: "preparing",
    });

    // 4) Start driver simulator
    startDriverSimulator(driverDoc.$id, {
      startLat: Number(rest.lat),
      startLng: Number(rest.lng),
      destLat,
      destLng,
      orderId: orderDoc.$id,
    });

    // 5) Handle UPI
// 5) Handle UPI
if (paymentMethod === "UPI") {
  try {
    if (!BASE) throw new Error("PUBLIC_BASE_URL missing");
    const plRef = `${orderDoc.$id}-${Date.now()}`;
   const callbackUrl = `${BASE}/rzp/callback?ref=${encodeURIComponent(orderDoc.$id)}`;
    // ✅ ensure amount is integer paise
    const amountPaise = Math.round(parseFloat(total) * 100);
    if (!amountPaise || isNaN(amountPaise)) {
      throw new Error(`Invalid order total: ${total}`);
    }
const paymentPayload = {
  amount: Math.round(Number(total) * 100),
  currency: "INR",
  accept_partial: false,
  reference_id: plRef,
  description: `Foodie order ${orderDoc.$id}`,
  customer: {
    name: address?.fullName || "Foodie Customer",
    email: address?.email || undefined,
    contact: address?.phone || undefined,
  },
  notify: { sms: !!address?.phone, email: !!address?.email },
  reminder_enable: true,
  callback_url: callbackUrl,
  callback_method: "get",
  notes: { referenceId: orderDoc.$id },
};

// 👇 only set upi_link in live mode
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_ID.startsWith("rzp_live_")) {
  paymentPayload.upi_link = true;
}

const link = await razorpay.paymentLink.create(paymentPayload);


    await db.updateDocument(DB_ID, ORDERS, orderDoc.$id, {
      status: "pending_payment",
      paymentStatus: "pending",
    });

    console.log("✅ Order created (UPI):", orderDoc.$id);
    return res.json({ ok: true, order: orderDoc, payment: link });
  } catch (err) {
    console.error("⚠️ Razorpay link error:", {
      message: err?.message,
      error: err?.error || null,
      stack: err?.stack,
    });
    return res.status(500).json({
      error: "upi_order_failed",
      detail: err?.message || "unknown",
    });
  }
}


    // COD → return order
    console.log("✅ Order created (COD):", orderDoc.$id);
    return res.json({ ok: true, order: orderDoc });

  } catch (e) {
    console.error("❌ create-order error:", e?.message || e);
    return res.status(500).json({ error: "failed_to_create_order", detail: e?.message });
  }
});

/* --------------------------------------------------------------------------
   🚀 Driver Simulator (auto runs per order)
-------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------
   🚀 Driver Simulator (auto status transitions)
-------------------------------------------------------------------------- */
async function startDriverSimulator(driverId, { startLat, startLng, destLat, destLng, orderId }) {
  console.log(`[SIM] Starting driver simulator for order ${orderId}`);

  let lat = startLat, lng = startLng;
  const step = 0.00087; // ≈ 95m per step
  const threshold = 0.0005; // ≈ 55m
  let ticks = 0;

  // Step 1: mark order as preparing
  try {
    await db.updateDocument(DB_ID, ORDERS, orderId, { status: "preparing" });
    console.log(`[SIM] Order ${orderId} → preparing`);
  } catch (e) {
    console.warn("[SIM] failed to set preparing:", e?.message || e);
  }

  // After short delay, switch to on_the_way
  setTimeout(async () => {
    try {
      await db.updateDocument(DB_ID, ORDERS, orderId, { status: "on_the_way" });
      await db.updateDocument(DB_ID, DRIVERS, driverId, { status: "on_the_way" });
      console.log(`[SIM] Order ${orderId} → on_the_way`);
    } catch (e) {
      console.warn("[SIM] failed to set on_the_way:", e?.message || e);
    }
  }, 5000);

  // Step 2: move driver until delivered
  const interval = setInterval(async () => {
    ticks++;
    try {
      const dLat = destLat - lat;
      const dLng = destLng - lng;

      console.log(`[SIM] Tick ${ticks} | dLat=${dLat.toFixed(6)} dLng=${dLng.toFixed(6)} lat=${lat.toFixed(6)} lng=${lng.toFixed(6)}`);

      // Arrived?
      if (Math.abs(dLat) < threshold && Math.abs(dLng) < threshold) {
        console.log(`[SIM] Order ${orderId} arrived within threshold after ${ticks} ticks`);
        await db.updateDocument(DB_ID, DRIVERS, driverId, {
          lat: destLat,
          lng: destLng,
          status: "delivered",
        });

        const order = await db.getDocument(DB_ID, ORDERS, orderId);
        await db.updateDocument(DB_ID, ORDERS, orderId, {
          status: "delivered",
          paymentStatus:
            order.paymentMethod === "COD" ? "paid" : order.paymentStatus,
        });

        console.log(`[SIM] Order ${orderId} delivered ✅`);
        clearInterval(interval);
        return;
      }

      // Move closer step by step
      lat += step * Math.sign(dLat);
      lng += step * Math.sign(dLng);

      await db.updateDocument(DB_ID, DRIVERS, driverId, { lat, lng });
      console.log(`[SIM] Driver ${driverId} moved closer`);
    } catch (e) {
      console.error("[SIM] error during tick", e);
      clearInterval(interval);
    }
  }, 5000);
}

app.get('/rzp/callback', async (req, res) => {
  try {
    let orderIdFromNotes = String(req.query.ref || '');
    const linkId = req.query.razorpay_payment_link_id || '';
    let finalPaid = req.query.razorpay_payment_link_status === 'paid';

    if (linkId) {
      try {
        const link = await razorpay.paymentLink.fetch(linkId);
        if (link?.status === 'paid') finalPaid = true;
        if (link?.notes?.referenceId) orderIdFromNotes = link.notes.referenceId;
      } catch {}
    }

    if (finalPaid && orderIdFromNotes) {
      await db.updateDocument(DB_ID, ORDERS, orderIdFromNotes, {
        paymentStatus: 'paid'
        // do NOT overwrite status here
      });
    }

    if (req.query.user_redirect === '1') {
      const redirectUrl = `foodie://orders/${orderIdFromNotes}`;
      console.log("🔗 Redirecting user to:", redirectUrl);
      return res.redirect(redirectUrl);
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).send('callback_error');
  }
});

/* --------------------------------------------------------------------------
   Payment Status (client polls this if needed)
-------------------------------------------------------------------------- */
app.get('/api/payments/status/:referenceId', async (req, res) => {
  try {
    const ref = req.params.referenceId;
    const order = await db.getDocument(DB_ID, ORDERS, ref);
    const ps = String(order.paymentStatus || 'pending').toLowerCase();
    const normalized = ps === 'paid' ? 'paid' : ps === 'failed' ? 'failed' : 'pending';
    return res.json({ referenceId: ref, status: normalized, rawStatus: ps });
  } catch (err) {
    const msg = err?.error?.description || err?.message || 'unknown_error';
    console.error('status error:', msg, err?.error || err);
    return res.status(500).json({ error: 'failed_to_fetch_status', detail: msg });
  }
});

/* --------------------------------------------------------------------------
   Cancel Order (UPI pending or COD placed)
   - Idempotent
   - Allows UPI cancel while link is pending (status 'pending_payment' or paymentStatus 'pending')
-------------------------------------------------------------------------- */
app.post('/api/orders/cancel/:id', cancelHandler);
app.post('/api/payments/cancel/:id', cancelHandler);

async function cancelHandler(req, res) {
  try {
    const id = req.params.id;
    const doc = await db.getDocument(DB_ID, ORDERS, id);

    const pm = String(doc.paymentMethod || "").toUpperCase(); // 'UPI' | 'COD'
    const ps = String(doc.paymentStatus || "").toLowerCase(); // 'pending' | 'paid' | 'failed'
    const st = String(doc.status || "").toLowerCase();        // 'placed' | 'pending_payment' | 'accepted' | ...

    // ✅ Already cancelled
    if (st === "canceled") {
      return res.json({ ok: true, id, already: true });
    }

    // ❌ Block if already delivered
    if (st === "delivered") {
      return res.status(409).json({
        error: "not_cancellable",
        reason: "already_delivered",
      });
    }

    // ✅ COD cancellable before delivered
    const canCOD = pm === "COD" && st !== "delivered";

    // ✅ UPI cancellable if still pending
    const canUPI = pm === "UPI" && (ps === "pending" || st === "pending_payment");

    if (!canUPI && !canCOD) {
      return res.status(409).json({
        error: "not_cancellable",
        reason: { paymentMethod: pm, paymentStatus: ps, status: st },
      });
    }

    await db.deleteDocument(DB_ID, ORDERS, id); // 👈 hard delete from DB

    // Cleanup driver docs if any
    try {
      const drivers = await db.listDocuments(DB_ID, DRIVERS, [Query.equal("orderId", id)]);
      await Promise.all(
        (drivers.documents || []).map((d) =>
          db.deleteDocument(DB_ID, DRIVERS, d.$id)
        )
      );
    } catch (err) {
      console.warn("[cancelHandler] driver cleanup failed:", err?.message || err);
    }

    return res.json({ ok: true, id, cancelled: true, method: pm });
  } catch (e) {
    console.error("cancel error:", e?.message || e);
    return res.status(500).json({
      error: "cancel_failed",
      detail: e?.message || "unknown_error",
    });
  }
}




/* --------------------------------- Start ---------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('payments-service listening on', PORT));
