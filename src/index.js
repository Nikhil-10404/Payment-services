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

// ---- Utils ----
const normalizePL = (s) => {
  switch ((s || '').toLowerCase()) {
    case 'paid': return 'paid';
    case 'expired': return 'expired';
    case 'canceled': return 'canceled';
    case 'processing':
    case 'issued':
    case 'created':
    default: return 'pending';
  }
};

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'payments-service', env: process.env.NODE_ENV || 'dev' });
});

// ---- Webhook MUST use raw body ----
app.post('/api/razorpay/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const sig = req.headers['x-razorpay-signature'];
  const raw = req.body.toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (expected !== sig) return res.status(400).send('Invalid signature');

  const evt = JSON.parse(raw);
  const p = evt?.payload?.payment?.entity; // Razorpay payment object
  // For payment-links, the payment contains invoice_id = payment_link id
  const linkId = p?.invoice_id;

  try {
    if (evt.event === 'payment.captured') {
      // find order by linkId (we stored linkId on order doc)
      // If you indexed referenceId instead, you can keep a map; here we’ll list by linkId stored.
      // Appwrite doesn’t query by arbitrary field without Index – add an index on 'linkId' if possible!
      // If no index, you can store referenceId in payment.notes and read it back from webhook p.notes
      // For simplicity assume we stored order $id as referenceId in paymentLink.notes.referenceId
      const ref = p?.notes?.referenceId;
  if (ref) {
    await db.updateDocument(DB_ID, ORDERS, ref, {
      paymentStatus: 'paid',
      status: 'placed',           // only now it's truly "placed"
      razorpayPaymentId: p.id,
    });
  }
      console.log('💰 payment.captured', p.id, 'order:', ref, 'link:', linkId);
    } else if (evt.event === 'payment.failed') {
      const ref = p?.notes?.referenceId;
  if (ref) {
    await db.updateDocument(DB_ID, ORDERS, ref, {
      paymentStatus: 'failed',
      status: 'canceled',         // match your enum spelling
    });
  }
      console.log('❌ payment.failed', p?.id, 'order:', ref, 'link:', linkId);
    }
  } catch (e) {
    console.error('webhook update error', e?.message || e);
  }

  return res.json({ ok: true });
});

// Normal JSON for the rest
app.use(express.json({ limit: '1mb' }));

// ---- Create Payment Link and attach to order ----
// ---- Create Payment Link and attach to order (idempotent/retry-safe) ----
// ---- Create Payment Link and attach to order (idempotent/retry-safe) ----
// src/index.js  — KEEP ONLY THIS definition for /api/payments/create-link
app.post('/api/payments/create-link', async (req, res) => {
  try {
    const { amount, name, email, contact, referenceId, callbackUrl } = req.body;
    if (!amount || !referenceId) {
      return res.status(400).json({ error: 'amount and referenceId are required' });
    }

    // 1) Load order
    const order = await db.getDocument(DB_ID, ORDERS, referenceId).catch(() => null);
    if (!order) return res.status(404).json({ error: 'order_not_found' });

    // 2) Reuse current link if still payable
    if (order.linkId) {
      try {
        const existing = await razorpay.paymentLink.fetch(order.linkId);
        const st = (existing.status || '').toLowerCase(); // created | issued | processing | paid | cancelled | expired
        if (st === 'created' || st === 'issued' || st === 'processing') {
          return res.json({
            id: existing.id,
            short_url: existing.short_url,
            status: existing.status,
            reference_id: existing.reference_id,
          });
        }
        if (st === 'paid') {
          await db.updateDocument(DB_ID, ORDERS, referenceId, {
            paymentStatus: 'paid',
            status: 'placed',
            updatedAt: new Date().toISOString(),
          });
          return res.status(409).json({ error: 'already_paid' });
        }
        // else cancelled/expired -> continue to create a new link
      } catch (_) {
        // ignore, create new link below
      }
    }

    // 3) Unique reference for THIS link attempt
    const attempt = Number(order.linkAttempt || 0) + 1;
    let plRef = `${referenceId}-a${attempt}`;

    const cbUrl =
      callbackUrl ||
      process.env.PUBLIC_CALLBACK_URL ||
      'https://example.com/thank-you';

    // 4) Create new link (with retry if Razorpay says ref already exists)
    let link;
    try {
      link = await razorpay.paymentLink.create({
        amount: Math.round(Number(amount) * 100),
        currency: 'INR',
        accept_partial: false,
        reference_id: plRef,           // must be unique
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
        notes: { referenceId },        // map back to Appwrite order $id
      });
    } catch (err) {
      const msg = (err?.error?.description || '').toLowerCase();
      if (msg.includes('reference_id') && msg.includes('already exist')) {
        // Recover by fetching existing link with the same plRef and returning it
        const list = await razorpay.paymentLink
          .all({ reference_id: plRef, count: 1 })
          .catch(() => null);
        const existing = list?.items?.[0];
        if (existing) {
          // Persist on order and return
          await db.updateDocument(DB_ID, ORDERS, referenceId, {
            referenceId,
            linkId: existing.id,
            linkAttempt: attempt,
            gateway: 'razorpay',
            updatedAt: new Date().toISOString(),
          });
          return res.json({
            id: existing.id,
            short_url: existing.short_url,
            status: existing.status,
            reference_id: existing.reference_id,
          });
        }
        // If somehow not found, bump attempt and try create once more
        const attempt2 = attempt + 1;
        plRef = `${referenceId}-a${attempt2}`;
        link = await razorpay.paymentLink.create({
          amount: Math.round(Number(amount) * 100),
          currency: 'INR',
          accept_partial: false,
          reference_id: plRef,
          description: 'Foodie order payment',
          customer: { name: name || 'Guest', email: email || undefined, contact: contact || undefined },
          notify: { sms: !!contact, email: !!email },
          reminder_enable: true,
          callback_url: cbUrl,
          callback_method: 'get',
          notes: { referenceId },
        });
        // Persist new attempt value
        await db.updateDocument(DB_ID, ORDERS, referenceId, {
          referenceId,
          linkId: link.id,
          linkAttempt: attempt2,
          gateway: 'razorpay',
          updatedAt: new Date().toISOString(),
        });
        return res.json({
          id: link.id,
          short_url: link.short_url,
          status: link.status,
          reference_id: plRef,
        });
      }
      // Unknown error
      throw err;
    }

    // 5) Persist newest link on the order
    await db.updateDocument(DB_ID, ORDERS, referenceId, {
      referenceId,
      linkId: link.id,
      linkAttempt: attempt,
      gateway: 'razorpay',
      updatedAt: new Date().toISOString(),
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




// ---- Status endpoint for success screen polling ----
app.get('/api/payments/status/:referenceId', async (req, res) => {
  try {
    const ref = req.params.referenceId;
    const order = await db.getDocument(DB_ID, ORDERS, ref);

    // If we already have final state from webhook, return quickly
    if (order.paymentStatus === 'paid') {
     return res.json({ referenceId: ref, status: 'paid', rawStatus: 'paid', linkId: order.linkId, updatedAt: order.$updatedAt });

    }
    if (order.paymentStatus === 'failed') {
      return res.json({ referenceId: ref, status: 'failed', rawStatus: 'failed', linkId: order.linkId, updatedAt: order.$updatedAt });

    }

    // Otherwise ask Razorpay for the payment-link status
    if (!order.linkId) return res.json({ referenceId: ref, status: 'pending', rawStatus: 'created', linkId: null, updatedAt: order.$updatedAt });

    const link = await razorpay.paymentLink.fetch(order.linkId);
    const normalized = normalizePL(link.status);

    // reflect it into the doc if it changed
    if (normalized === 'paid' && order.paymentStatus !== 'paid') {
      await db.updateDocument(DB_ID, ORDERS, ref, { paymentStatus: 'paid' });

    } else if (normalized === 'expired' || normalized === 'canceled') {
      await db.updateDocument(DB_ID, ORDERS, ref, { paymentStatus: 'failed' });

    }

    return res.json({ referenceId: ref, status: normalized, rawStatus: link.status, linkId: order.linkId, updatedAt: order.$updatedAt });

  } catch (err) {
    const msg = err?.error?.description || err?.message || 'unknown_error';
    console.error('status error:', msg, err?.error || err);
    return res.status(500).json({ error: 'failed_to_fetch_status', detail: msg });
  }
});

// src/index.js (after other routes)
app.post('/api/orders/cancel/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await db.getDocument(DB_ID, ORDERS, id);

    // Only allow cancel in these cases:
    if (
      (doc.paymentMethod === 'UPI' && doc.paymentStatus === 'pending') ||
      (doc.paymentMethod === 'COD' && doc.status === 'placed')
    ) {
      await db.updateDocument(DB_ID, ORDERS, id, {
        status: 'canceled',
        paymentStatus: doc.paymentMethod === 'UPI' ? 'failed' : doc.paymentStatus,
      });
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'not_cancellable' });
  } catch (e) {
    return res.status(500).json({ error: 'cancel_failed', detail: e?.message });
  }
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('payments-service listening on', PORT));
