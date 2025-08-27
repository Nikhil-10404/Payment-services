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
    case 'cancelled': return 'cancelled';
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
      const ref = p?.notes?.referenceId; // set when creating link (see below)
      if (ref) {
        await db.updateDocument(DB_ID, ORDERS, ref, {
          paymentStatus: 'paid',
          status: 'accepted',
          razorpayPaymentId: p.id,
          updatedAt: new Date().toISOString(),
        });
      }
      console.log('💰 payment.captured', p.id, 'order:', ref, 'link:', linkId);
    } else if (evt.event === 'payment.failed') {
      const ref = p?.notes?.referenceId;
      if (ref) {
        await db.updateDocument(DB_ID, ORDERS, ref, {
          paymentStatus: 'failed',
          status: 'cancelled',
          updatedAt: new Date().toISOString(),
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
app.post('/api/payments/create-link', async (req, res) => {
  try {
    const { amount, name, email, contact, referenceId } = req.body;
    if (!amount || !referenceId) return res.status(400).json({ error: 'amount and referenceId are required' });

    // Create payment-link (UPI only if you disabled others in Razorpay dashboard)
    const link = await razorpay.paymentLink.create({
      amount: Math.round(Number(amount) * 100),
      currency: 'INR',
      accept_partial: false,
      reference_id: referenceId,
      description: 'Foodie order payment',
      customer: {
        name: name || 'Guest',
        email: email || undefined,
        contact: contact || undefined,
      },
      notify: { sms: !!contact, email: !!email },
      reminder_enable: true,
      callback_url: process.env.PUBLIC_CALLBACK_URL || 'https://example.com/thank-you',
      callback_method: 'get',
      // IMPORTANT: include referenceId in notes so we can read it inside webhook -> payment.notes.referenceId
      notes: { referenceId },
    });

    // Attach linkId/referenceId to your order doc
    await db.updateDocument(DB_ID, ORDERS, referenceId, {
      referenceId,
      linkId: link.id,
      gateway: 'razorpay',
      updatedAt: new Date().toISOString(),
    });

    return res.json({
      id: link.id,
      short_url: link.short_url,
      status: link.status,
      reference_id: referenceId,
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
      return res.json({ referenceId: ref, status: 'paid', rawStatus: 'paid', linkId: order.linkId, updatedAt: order.updatedAt });
    }
    if (order.paymentStatus === 'failed') {
      return res.json({ referenceId: ref, status: 'failed', rawStatus: 'failed', linkId: order.linkId, updatedAt: order.updatedAt });
    }

    // Otherwise ask Razorpay for the payment-link status
    if (!order.linkId) return res.json({ referenceId: ref, status: 'pending', rawStatus: 'created', linkId: null, updatedAt: order.updatedAt });

    const link = await razorpay.paymentLink.fetch(order.linkId);
    const normalized = normalizePL(link.status);

    // reflect it into the doc if it changed
    if (normalized === 'paid' && order.paymentStatus !== 'paid') {
      await db.updateDocument(DB_ID, ORDERS, ref, { paymentStatus: 'paid', updatedAt: new Date().toISOString() });
    } else if (normalized === 'expired' || normalized === 'cancelled') {
      await db.updateDocument(DB_ID, ORDERS, ref, { paymentStatus: 'failed', updatedAt: new Date().toISOString() });
    }

    return res.json({ referenceId: ref, status: normalized, rawStatus: link.status, linkId: order.linkId, updatedAt: new Date().toISOString() });
  } catch (err) {
    const msg = err?.error?.description || err?.message || 'unknown_error';
    console.error('status error:', msg, err?.error || err);
    return res.status(500).json({ error: 'failed_to_fetch_status', detail: msg });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('payments-service listening on', PORT));
