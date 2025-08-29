// server.js  (or src/index.js)
// Node ESM (package.json should have: { "type": "module" })
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
   Razorpay Webhook  (RAW BODY before any express.json())
   Configure in Razorpay Dashboard → Settings → Webhooks
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

    // Preferred for Payment Links
    if (evt?.event === 'payment_link.paid') {
      const notesRef = evt?.payload?.payment_link?.entity?.notes?.referenceId; // our Appwrite order $id
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

    // Also handle captured payments (covers some flows)
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

    // Optional: mark failed
    if (evt?.event === 'payment.failed') {
      const p = evt?.payload?.payment?.entity;
      const orderId = p?.notes?.referenceId;
      if (orderId) {
        try {
          await db.updateDocument(DB_ID, ORDERS, orderId, {
            paymentStatus: 'failed',
            status: 'canceled', // one L
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

/* ---------------------------- JSON for other routes ------------------------ */
app.use(express.json({ limit: '1mb' }));

/* --------------------------------------------------------------------------
   Create Payment Link (UPI-ready) — FIXES callback_url issue
   Body: { amount, name?, email?, contact?, referenceId }
-------------------------------------------------------------------------- */
app.post('/api/payments/create-link', async (req, res) => {
  try {
    const { amount, name, email, contact, referenceId } = req.body;
    if (!amount || !referenceId) {
      return res.status(400).json({ error: 'amount and referenceId are required' });
    }

    // Order must exist
    const order = await db.getDocument(DB_ID, ORDERS, referenceId).catch(() => null);
    if (!order) return res.status(404).json({ error: 'order_not_found' });

    // If already paid, short circuit
    const ps = String(order.paymentStatus || '').toLowerCase();
    if (ps === 'paid') return res.status(409).json({ error: 'already_paid' });

    // Unique per attempt (Razorpay requirement)
    const plRef = `${referenceId}-${Date.now()}`;

    if (!BASE) {
      return res.status(500).json({ error: 'server_not_configured', detail: 'PUBLIC_BASE_URL missing' });
    }
    const callbackUrl = `${BASE}/rzp/callback?ref=${encodeURIComponent(referenceId)}`;

    const link = await razorpay.paymentLink.create({
      amount: Math.round(Number(amount) * 100), // paise
      currency: 'INR',
      accept_partial: false,
      upi_link: true,                   // 👈 ensure UPI payment link
      reference_id: plRef,
      description: `Foodie order ${referenceId}`,
      customer: {
        name: name || 'Foodie Customer',
        email: email || undefined,
        contact: contact || undefined,
      },
      notify: { sms: !!contact, email: !!email },
      reminder_enable: true,
      callback_url: callbackUrl,        // 👈 REQUIRED by Razorpay for UPI links
      callback_method: 'get',
      notes: { referenceId },           // Appwrite order $id for mapping
    });

    // Mark order as pending
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

/* --------------------------------------------------------------------------
   Razorpay Callback landing (user returns from UPI app)
   GET /rzp/callback?ref=<AppwriteOrderId>&razorpay_payment_link_id=...&razorpay_payment_link_status=paid
-------------------------------------------------------------------------- */
app.get('/rzp/callback', async (req, res) => {
  try {
    const appwriteOrderId = String(req.query.ref || '');
    const linkId = String(req.query.razorpay_payment_link_id || '');
    const linkStatus = String(req.query.razorpay_payment_link_status || ''); // paid / created / cancelled
    const paymentId = String(req.query.razorpay_payment_id || '');

    let finalPaid = linkStatus === 'paid';
    let orderIdFromNotes = appwriteOrderId;

    if (linkId) {
      try {
        const link = await razorpay.paymentLink.fetch(linkId);
        if (link?.status === 'paid') finalPaid = true;
        if (link?.notes?.referenceId) orderIdFromNotes = link.notes.referenceId;
      } catch (e) {
        console.warn('Fetch payment link failed:', e?.message || e);
      }
    }

    if (finalPaid && orderIdFromNotes) {
      try {
        await db.updateDocument(DB_ID, ORDERS, orderIdFromNotes, {
          paymentStatus: 'paid',
          status: 'placed',
        });
      } catch (e) {
        console.warn('Appwrite update (callback) failed:', e?.message || e);
      }
    }

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

    const pm = String(doc.paymentMethod || '').toUpperCase(); // 'UPI' | 'COD'
    const ps = String(doc.paymentStatus || '').toLowerCase(); // 'pending' | 'paid' | 'failed'
    const st = String(doc.status || '').toLowerCase();        // 'placed' | 'pending_payment' | 'accepted' | ...

    // Idempotent: already canceled
    if (st === 'canceled' || st === 'cancelled') {
      return res.json({ ok: true, id, already: true });
    }

    // Cancellable rules
    const canUPI = pm === 'UPI' && (ps === 'pending' || st === 'pending_payment');
    const canCOD = pm === 'COD' && st === 'placed';

    if (!canUPI && !canCOD) {
      return res.status(409).json({
        error: 'not_cancellable',
        reason: { paymentMethod: pm, paymentStatus: ps, status: st },
      });
    }

    await db.updateDocument(DB_ID, ORDERS, id, {
      status: 'canceled',                              // one L (your schema)
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
