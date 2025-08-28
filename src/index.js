// src/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { Client, Databases } from 'node-appwrite';

const app = express();
app.use(cors());
app.use(morgan('dev'));

// ---- Razorpay client ----
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ---- Appwrite server client ----
const awClient = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const db = new Databases(awClient);
const DB_ID = process.env.APPWRITE_DATABASE_ID;
const ORDERS = process.env.APPWRITE_ORDERS_COLLECTION_ID;

// ---- Health ----
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'payments-service', env: process.env.NODE_ENV || 'dev' });
});

/* ------------------------------------------------------------------
   Razorpay Webhook
   NOTE: must use raw body BEFORE express.json()
------------------------------------------------------------------ */
app.post('/api/razorpay/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const sig = req.headers['x-razorpay-signature'];
    const raw = req.body.toString('utf8');
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (expected !== sig) return res.status(400).send('Invalid signature');

    const evt = JSON.parse(raw);
    const p = evt?.payload?.payment?.entity; // Razorpay payment
    const ref = p?.notes?.referenceId;       // we store Appwrite order $id here when creating link

    if (!ref) return res.json({ ok: true });

    if (evt.event === 'payment.captured') {
      // Only write fields that exist in your Orders schema
      await db.updateDocument(DB_ID, ORDERS, ref, {
        paymentStatus: 'paid',
        status: 'placed',
      });
      console.log('💰 payment.captured', p?.id, 'order:', ref);
    } else if (evt.event === 'payment.failed') {
      await db.updateDocument(DB_ID, ORDERS, ref, {
        paymentStatus: 'failed',
        status: 'canceled',
      });
      console.log('❌ payment.failed', p?.id, 'order:', ref);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('webhook error:', e?.message || e);
    return res.status(500).send('webhook_error');
  }
});

// Normal JSON for the rest
app.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------
   Create Payment Link  (ALWAYS unique reference_id; no unknown fields)
------------------------------------------------------------------ */
app.post('/api/payments/create-link', async (req, res) => {
  try {
    const { amount, name, email, contact, referenceId, callbackUrl } = req.body;
    if (!amount || !referenceId) {
      return res.status(400).json({ error: 'amount and referenceId are required' });
    }

    // 1) Ensure order exists
    const order = await db.getDocument(DB_ID, ORDERS, referenceId).catch(() => null);
    if (!order) return res.status(404).json({ error: 'order_not_found' });

    // If already paid, short circuit
    const ps = (order.paymentStatus || '').toLowerCase();
    if (ps === 'paid') return res.status(409).json({ error: 'already_paid' });

    // 2) Always build a UNIQUE payment-link reference_id (no DB counters)
    const plRef = `${referenceId}-${Date.now()}`;

    // 3) Callback URL (client -> env -> fallback)
    const cbUrl =
      callbackUrl ||
      process.env.PUBLIC_CALLBACK_URL ||
      'https://example.com/thank-you';

    // 4) Create payment link
    const link = await razorpay.paymentLink.create({
      amount: Math.round(Number(amount) * 100),
      currency: 'INR',
      accept_partial: false,
      reference_id: plRef, // unique per attempt
      description: 'Foodie order payment',
      customer: {
        name: name || 'Guest',
        email: email || undefined,
        contact: contact || undefined,
      },
      notify: { sms: !!contact, email: !!email },
      reminder_enable: true,
      callback_url: cbUrl,
      callback_method: 'get',
      notes: { referenceId }, // map back to Appwrite order $id for webhook
    });

    // 5) Mark order "pending_payment" safely (only allowed fields)
    try {
      await db.updateDocument(DB_ID, ORDERS, referenceId, {
        status: 'pending_payment',
        paymentStatus: 'pending',
      });
    } catch (_) {
      // ignore if your schema names differ
    }

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

/* ------------------------------------------------------------------
   Payment Status (read from Appwrite; webhook should have updated it)
------------------------------------------------------------------ */
app.get('/api/payments/status/:referenceId', async (req, res) => {
  try {
    const ref = req.params.referenceId;
    const order = await db.getDocument(DB_ID, ORDERS, ref);

    const ps = (order.paymentStatus || 'pending').toLowerCase();
    const normalized = ps === 'paid' ? 'paid'
                      : ps === 'failed' ? 'failed'
                      : 'pending';

    return res.json({
      referenceId: ref,
      status: normalized,
      rawStatus: ps,
    });
  } catch (err) {
    const msg = err?.error?.description || err?.message || 'unknown_error';
    console.error('status error:', msg, err?.error || err);
    return res.status(500).json({ error: 'failed_to_fetch_status', detail: msg });
  }
});

/* ------------------------------------------------------------------
   Cancel Order (works for UPI pending or COD placed)
   We expose two routes that share the same handler.
------------------------------------------------------------------ */
app.post('/api/orders/cancel/:id', cancelHandler);
app.post('/api/payments/cancel/:id', cancelHandler);

async function cancelHandler(req, res) {
  try {
    const id = req.params.id;
    const doc = await db.getDocument(DB_ID, ORDERS, id);

    const pm = (doc.paymentMethod || '').toUpperCase();
    const ps = (doc.paymentStatus || '').toLowerCase();
    const st = (doc.status || '').toLowerCase();

    const canUPI = pm === 'UPI' && ps === 'pending';
    const canCOD = pm === 'COD' && st === 'placed';

    if (!canUPI && !canCOD) {
      return res.status(400).json({ error: 'not_cancellable' });
    }

    await db.updateDocument(DB_ID, ORDERS, id, {
      status: 'canceled',
      paymentStatus: canUPI ? 'failed' : doc.paymentStatus,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('cancel error:', e?.message || e);
    return res.status(500).json({ error: 'cancel_failed', detail: e?.message });
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('payments-service listening on', PORT));
