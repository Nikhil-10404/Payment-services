// server.js  (or src/index.js)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import crypto from 'crypto';
import Razorpay from 'razorpay';
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
const RESTAURANTS = process.env.APPWRITE_RESTAURANTS_COLLECTION_ID; // 👈 new
const DRIVERS = process.env.APPWRITE_DRIVERS_COLLECTION_ID;         // 👈 new

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
        try {
          await db.updateDocument(DB_ID, ORDERS, notesRef, {
            paymentStatus: 'paid',
            status: 'placed',
          });
        } catch (e) {
          console.warn('[Webhook] Appwrite update failed:', e?.message || e);
        }
      }
      return res.json({ ok: true });
    }

    if (evt?.event === 'payment.captured') {
      const p = evt?.payload?.payment?.entity;
      const orderId = p?.notes?.referenceId;
      if (orderId) {
        try {
          await db.updateDocument(DB_ID, ORDERS, orderId, {
            paymentStatus: 'paid',
            status: 'placed',
          });
        } catch (e) {
          console.warn('[Webhook] Appwrite update (captured) failed:', e?.message || e);
        }
      }
      return res.json({ ok: true });
    }

    if (evt?.event === 'payment.failed') {
      const p = evt?.payload?.payment?.entity;
      const orderId = p?.notes?.referenceId;
      if (orderId) {
        try {
          await db.updateDocument(DB_ID, ORDERS, orderId, {
            paymentStatus: 'failed',
            status: 'canceled',
          });
        } catch (e) {
          console.warn('[Webhook] Appwrite update (failed) failed:', e?.message || e);
        }
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

/* --------------------------------------------------------------------------
   NEW: Create COD Order + Driver entry
-------------------------------------------------------------------------- */
/* ------------------------------------------------------------------
   Create Order (COD or UPI) → also creates driver doc
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
      address,
      paymentMethod,
    } = req.body;

    if (!restaurantId || !items || !total || !paymentMethod) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // 1) Create order doc
    const orderDoc = await db.createDocument(DB_ID, ORDERS, 'unique()', {
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
      paymentStatus: paymentMethod === 'COD' ? 'pending' : 'pending',
      status: 'placed',
    });

    // 2) Fetch restaurant to get coords
    const rest = await db.getDocument(DB_ID, process.env.APPWRITE_RESTAURANTS_COLLECTION_ID, restaurantId);

    // 3) Create driver doc (initial location = restaurant coords)
    await db.createDocument(DB_ID, process.env.APPWRITE_DRIVERS_COLLECTION_ID, 'unique()', {
      orderId: orderDoc.$id,
      lat: rest.lat,
      lng: rest.lng,
      status: 'delivering',
    });

    // 4) If UPI, also create a Razorpay link
    if (paymentMethod === 'UPI') {
      const base = process.env.PUBLIC_BASE_URL;
      const linkRes = await fetch(`${base}/api/payments/create-link`, {
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

    // COD
    return res.json({ ok: true, order: orderDoc });
  } catch (e) {
    console.error('create-order error:', e?.message || e);
    return res.status(500).json({ error: 'failed_to_create_order', detail: e?.message });
  }
});


/* --------------------------------------------------------------------------
   Payment Link creation (UPI)
-------------------------------------------------------------------------- */
app.post('/api/payments/create-link', async (req, res) => {
  try {
    const { amount, name, email, contact, referenceId } = req.body;
    if (!amount || !referenceId) {
      return res.status(400).json({ error: 'amount and referenceId are required' });
    }

    const order = await db.getDocument(DB_ID, ORDERS, referenceId).catch(() => null);
    if (!order) return res.status(404).json({ error: 'order_not_found' });

    const ps = String(order.paymentStatus || '').toLowerCase();
    if (ps === 'paid') return res.status(409).json({ error: 'already_paid' });

    const plRef = `${referenceId}-${Date.now()}`;
    const callbackUrl = `${BASE}/rzp/callback?ref=${encodeURIComponent(referenceId)}`;

    const link = await razorpay.paymentLink.create({
      amount: Math.round(Number(amount) * 100),
      currency: 'INR',
      accept_partial: false,
      upi_link: true,
      reference_id: plRef,
      description: `Foodie order ${referenceId}`,
      customer: { name: name || 'Foodie Customer', email, contact },
      notify: { sms: !!contact, email: !!email },
      reminder_enable: true,
      callback_url: callbackUrl,
      callback_method: 'get',
      notes: { referenceId },
    });

    await db.updateDocument(DB_ID, ORDERS, referenceId, {
      status: 'pending_payment',
      paymentStatus: 'pending',
    });

    return res.json({
      id: link.id,
      short_url: link.short_url,
      status: link.status,
      reference_id: plRef,
    });
  } catch (err) {
    const msg = err?.error?.description || err?.message || 'unknown_error';
    console.error('create-link error:', msg, err?.error || err);
    return res.status(500).json({ error: 'failed_to_create_payment_link', detail: msg });
  }
});

/* --------------------------------------------------------------------------
   Payment status, cancel, etc (unchanged from your code)
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

app.post('/api/orders/cancel/:id', cancelHandler);
app.post('/api/payments/cancel/:id', cancelHandler);

async function cancelHandler(req, res) {
  try {
    const id = req.params.id;
    const doc = await db.getDocument(DB_ID, ORDERS, id);
    const pm = String(doc.paymentMethod || '').toUpperCase();
    const ps = String(doc.paymentStatus || '').toLowerCase();
    const st = String(doc.status || '').toLowerCase();

    if (st === 'canceled' || st === 'cancelled') {
      return res.json({ ok: true, id, already: true });
    }

    const canUPI = pm === 'UPI' && (ps === 'pending' || st === 'pending_payment');
    const canCOD = pm === 'COD' && st === 'placed';

    if (!canUPI && !canCOD) {
      return res.status(409).json({
        error: 'not_cancellable',
        reason: { paymentMethod: pm, paymentStatus: ps, status: st },
      });
    }

    await db.updateDocument(DB_ID, ORDERS, id, {
      status: 'canceled',
      paymentStatus: canUPI ? 'failed' : doc.paymentStatus,
    });

    return res.json({ ok: true, id });
  } catch (e) {
    console.error('cancel error:', e?.message || e);
    return res.status(500).json({ error: 'cancel_failed', detail: e?.message || 'unknown_error' });
  }
}

/* --------------------------------- Start ---------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('payments-service listening on', PORT));
