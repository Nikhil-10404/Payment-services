import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import crypto from 'crypto';
import Razorpay from 'razorpay';

const app = express();
app.use(cors());
app.use(morgan('dev'));

// ---------- Razorpay client ----------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ---------- HEALTH ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'payments-service', env: process.env.NODE_ENV || 'dev' });
});

/**
 * IMPORTANT: Webhook must read the RAW body to compute the HMAC exactly as Razorpay sent it.
 * So we mount this route BEFORE any global express.json().
 */
app.post(
  '/api/razorpay/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.body.toString('utf8');

    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (expected !== signature) {
      console.log('⚠️  Webhook signature mismatch');
      return res.status(400).send('Invalid signature');
    }

    const event = JSON.parse(rawBody);
    console.log('✅ Webhook verified:', event.event);

    // Basic handling
    if (event.event === 'payment.captured') {
      const p = event.payload.payment.entity;
      console.log('💰 Payment success:', {
        payment_id: p.id,
        amount: p.amount / 100,
        method: p.method,
        email: p.email,
        contact: p.contact,
      });
      // TODO: mark order as PAID in your DB here (using your own reference/notes)
    } else if (event.event === 'payment.failed') {
      const p = event.payload.payment.entity;
      console.log('❌ Payment failed:', p.id, p.error_description || '');
      // TODO: mark order as FAILED in your DB
    }
    // Always 200 so Razorpay doesn't keep retrying
    return res.status(200).json({ ok: true });
  }
);

// For all other routes we can use JSON parser normally
app.use(express.json({ limit: '1mb' }));

/**
 * Create a Hosted Checkout Payment Link (best for Expo Go).
 * body: { amount, name, email, contact, referenceId, notes }
 * amount is in rupees here; we'll convert to paise.
 */
app.post('/api/payments/create-link', async (req, res) => {
  try {
    const {
      amount,                 // e.g. 99
      name,
      email,
      contact,
      referenceId,            // your order id if you have one
      notes = {}              // optional object
    } = req.body;

    if (!amount) {
      return res.status(400).json({ error: 'amount (₹) is required' });
    }

    const rupees = Number(amount);
    if (Number.isNaN(rupees) || rupees <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const payload = {
      amount: Math.round(rupees * 100), // paise
      currency: 'INR',
      accept_partial: false,
      reference_id: referenceId || `ref_${Date.now()}`,
      description: 'Foodie order payment',
      customer: {
        name: name || 'Guest User',
        email: email || undefined,
        contact: contact || undefined,
      },
      notify: { sms: !!contact, email: !!email },
      reminder_enable: true,
      // after payment, Razorpay can redirect user to a page you control:
      callback_url: process.env.PUBLIC_CALLBACK_URL || 'https://example.com/thank-you',
      callback_method: 'get',
      notes,
    };

    // Create the payment link
    const link = await razorpay.paymentLink.create(payload);

    // Return the URL you’ll open from Expo
    return res.json({
      id: link.id,
      short_url: link.short_url,     // open this in Expo (WebBrowser)
      status: link.status,           // created
      reference_id: link.reference_id,
    });
  } catch (err) {
    console.error('create-link error:', err?.error || err);
    return res.status(500).json({ error: 'failed_to_create_payment_link' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('payments-service listening on', PORT);
});
