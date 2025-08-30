// server.js (or src/index.js)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import fetch from 'node-fetch'; // make sure installed: npm install node-fetch
import { Client, Databases, ID } from 'node-appwrite';

const app = express();
app.use(cors());
app.use(morgan('dev'));

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

app.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------
   Create Order (COD or UPI) → auto-create driver doc & start simulator
------------------------------------------------------------------ */
app.post('/api/orders/create', async (req, res) => {
  try {
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
      address,       // should include lat/lng
      paymentMethod,
    } = req.body;

    if (!restaurantId || !items || !total || !paymentMethod) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // 1) Create order doc
    const orderDoc = await db.createDocument(DB_ID, ORDERS, ID.unique(), {
      restaurantId,
      restaurantName,
      items: JSON.stringify(items),
      subTotal,
      platformFee,
      deliveryFee,
      gst,
      discount,
      total,
      address: JSON.stringify(address),
      paymentMethod,
      paymentStatus: 'pending',
      status: 'placed',
    });

    // 2) Get restaurant (start point)
    const rest = await db.getDocument(DB_ID, RESTAURANTS, restaurantId);

    // 3) Destination from address
    let destLat = address?.lat, destLng = address?.lng;
    if (!destLat || !destLng) {
      console.warn('[WARN] No lat/lng in address payload, fallback 0,0');
      destLat = 0; destLng = 0;
    }

    // 4) Create driver doc
    const driverDoc = await db.createDocument(DB_ID, DRIVERS, ID.unique(), {
      orderId: orderDoc.$id,
      lat: rest.lat,
      lng: rest.lng,
      destLat,
      destLng,
      status: 'delivering',
    });

    // 5) Start simulator 🚀
    startDriverSimulator(driverDoc.$id, {
      startLat: rest.lat,
      startLng: rest.lng,
      destLat,
      destLng,
      orderId: orderDoc.$id,
    });

    // 6) If UPI → create Razorpay link
    if (paymentMethod === 'UPI') {
      const linkRes = await fetch(`${BASE}/api/payments/create-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: total,
          name: address?.fullName,
          contact: address?.phone,
          referenceId: orderDoc.$id,
        }),
      });
      const linkJson = await linkRes.json();
      return res.json({ ok: true, order: orderDoc, payment: linkJson });
    }

    // COD → return order
    return res.json({ ok: true, order: orderDoc });
  } catch (e) {
    console.error('create-order error:', e?.message || e);
    return res.status(500).json({ error: 'failed_to_create_order', detail: e?.message });
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
  const step = 0.0005; // ≈ 50m per step

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
  }, 5000); // wait 5s in "preparing" before going out

  // Step 2: move driver until delivered
  const interval = setInterval(async () => {
    try {
      const dLat = destLat - lat;
      const dLng = destLng - lng;

      // Arrived
      if (Math.abs(dLat) < 0.0005 && Math.abs(dLng) < 0.0005) {
        await db.updateDocument(DB_ID, DRIVERS, driverId, {
          lat: destLat,
          lng: destLng,
          status: "delivered",
        });
        await db.updateDocument(DB_ID, ORDERS, orderId, {
          status: "delivered",
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
      console.error("[SIM] error", e?.message || e);
      clearInterval(interval);
    }
  }, 5000); // every 5s
}


/* --------------------------------- Start ---------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('payments-service listening on', PORT));
