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

const BASE = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
if (!BASE || !BASE.startsWith('http')) {
  console.warn('[WARN] PUBLIC_BASE_URL is missing or not http(s). Razorpay callback will fail.');
}

// ---- Health ----
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'payments-service', env: process.env.NODE_ENV || 'dev' });
});

/* ------------------------------------------------------------------
   Razorpay Webhook  (RAW BODY before any express.json())
------------------------------------------------------------------ */
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

    // payment_link.paid (recommended for Payment Links)
    if (evt?.event === 'payment_link.paid') {
      const ref = evt?.payload?.payment_link?.entity?.reference_id; // our unique per-attempt ref, not order id
      const notesRef = evt?.payload?.payment_link?.entity?.notes?.referenceId; // our Appwrite order $id (we set this)
      const appwriteOrderId = notesRef || null;

      if (appwriteOrderId) {
        try {
          await db.updateDocument(DB_ID, ORDERS, appwriteOrderId, {
            paymentStatus: 'paid',
            status: 'placed',
          });
        } catch (e) {
          console.warn('Appwrite update (payment_link.paid) failed', e?.message || e);
        }
      }
      return res.json({ ok: true });
    }

    // payment.captured (also works)
    if (evt?.event === 'payment.captured') {
      const p = evt?.payload?.payment?.entity;
      const appwriteOrderId = p?.notes?.referenceId; // we set notes.referenceId when creating link
      if (appwriteOrderId) {
        try {
          await db.updateDocument(DB_ID, ORDERS, appwriteOrderId, {
            paymentStatus: 'paid',
            status: 'placed',
          });
        } catch (e) {
          console.warn('Appwrite update (payment.captured) failed', e?.message || e);
        }
      }
      return res.json({ ok: true });
    }

    // payment.failed (optional)
    if (evt?.event === 'payment.failed') {
      const p = evt?.payload?.payment?.entity;
      const appwriteOrderId = p?.notes?.referenceId;
      if (appwriteOrderId) {
        try {
          await db.updateDocument(DB_ID, ORDERS, appwriteOrderId, {
            paymentStatus: 'failed',
            status: 'canceled',
          });
        } catch (e) {
          console.warn('Appwrite update (payment.failed) failed', e?.message || e);
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

// Normal JSON for the rest
app.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------
   Create Payment Link (UPI-ready)  — FIXES callback_url error
------------------------------------------------------------------ */
app.post('/api/payments/create-link', async (req, res) => {
  try {
    const { amount, name, email, contact, referenceId } = req.body;
    if (!amount || !referenceId) {
      return res.status(400).json({ error: 'amount and referenceId are required' });
    }

    // 1) Ensure order exists
    const order = await db.getDocument(DB_ID, ORDERS, referenceId).catch(() => null);
    if (!order) return res.status(404).json({ error: 'order_not_found' });

    const ps = String(order.paymentStatus || '').toLowerCase();
    if (ps === 'paid') return res.status(409).json({ error: 'already_paid' });

    // 2) Build unique per-attempt reference (Razorpay requirement)
    const plRef = `${referenceId}-${Date.now()}`;

    // 3) Always use a proper PUBLIC callback URL — no client override
    if (!BASE) return res.status(500).json({ error: 'server_not_configured', detail: 'PUBLIC_BASE_URL missing' });
    const callbackUrl = `${BASE}/rzp/callback?ref=${encodeURIComponent(referenceId)}`;

    // 4) Create a Payment Link with UPI enabled + callback_url
    const link = await razorpay.paymentLink.create({
      amount: Math.round(Number(amount) * 100), // paise
      currency: 'INR',
      accept_partial: false,
      upi_link: true,                    // 👈 ensure UPI link generation
      reference_id: plRef,               // unique per attempt
      description: `Foodie order ${referenceId}`,
      customer: {
        name: name || 'Foodie Customer',
        email: email || undefined,
        contact: contact || undefined,
      },
      notify: { sms: !!contact, email: !!email },
      reminder_enable: true,
      callback_url: callbackUrl,         // 👈 REQUIRED — fixes your error
      callback_method: 'get',
      notes: { referenceId },            // map back to Appwrite order $id
    });

    // 5) Mark order pending
    try {
      await db.updateDocument(DB_ID, ORDERS, referenceId, {
        status: 'pending_payment',
        paymentStatus: 'pending',
      });
    } catch (_) {}

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
   Razorpay Callback Landing (payment app returns here)
   We verify link status and update Appwrite.
------------------------------------------------------------------ */
app.get('/rzp/callback', async (req, res) => {
  try {
    const appwriteOrderId = String(req.query.ref || '');
    // Razorpay app appends these query params:
    const linkId = String(req.query.razorpay_payment_link_id || '');
    const linkStatus = String(req.query.razorpay_payment_link_status || ''); // paid / created / cancelled
    const paymentId = String(req.query.razorpay_payment_id || '');

    // Fetch Payment Link to read notes.referenceId (truth source) & status
    let finalPaid = linkStatus === 'paid';
    let orderIdFromNotes = appwriteOrderId;

    if (linkId) {
      try {
        const link = await razorpay.paymentLink.fetch(linkId);
        if (link?.status === 'paid') finalPaid = true;
        if (link?.notes?.referenceId) orderIdFromNotes = link.notes.referenceId;
      } catch (e) {
        console.warn('Fetch payment link failed', e?.message || e);
      }
    }

    if (finalPaid && orderIdFromNotes) {
      try {
        await db.updateDocument(DB_ID, ORDERS, orderIdFromNotes, {
          paymentStatus: 'paid',
          status: 'placed',
        });
      } catch (e) {
        console.warn('Appwrite update (callback) failed', e?.message || e);
      }
    }

    // Tiny HTML that tells the user to return to the app
    res.setHeader('Content-Type', 'text/html');
    return res.end(`
      <html>
        <head><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
        <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto;padding:24px;text-align:center;">
          <h2>${finalPaid ? 'Payment Successful 🎉' : 'Payment Pending'}</h2>
          <p>${finalPaid ? 'You can go back to Foodie now.' : 'If you have completed payment, please return to Foodie.'}</p>
          <button onclick="history.back()" style="padding:12px 18px;border-radius:10px;border:0;background:#111827;color:#fff;font-weight:800">Back</button>
          ${paymentId ? `<p style="color:#6b7280;margin-top:10px;">Txn: ${paymentId}</p>` : ''}
        </body>
      </html>
    `);
  } catch (e) {
    console.error('callback error:', e?.message || e);
    return res.status(500).send('callback_error');
  }
});

/* ------------------------------------------------------------------
   Payment Status (read from Appwrite — webhook/callback should update)
------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------
   Cancel Order (UPI pending or COD placed)
------------------------------------------------------------------ */
app.post('/api/orders/cancel/:id', cancelHandler);
app.post('/api/payments/cancel/:id', cancelHandler);

async function cancelHandler(req, res) {
  try {
    const id = req.params.id;
    const doc = await db.getDocument(DB_ID, ORDERS, id);

    const pm = String(doc.paymentMethod || '').toUpperCase();
    const ps = String(doc.paymentStatus || '').toLowerCase();
    const st = String(doc.status || '').toLowerCase();

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
