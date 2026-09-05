require('dotenv').config();
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const QRCode = require('qrcode');

const app = express();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Serves the customer-facing touchscreen page (public/index.html) at "/"
app.use(express.static(path.join(__dirname, 'public')));

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const orders = {};

// Queue of { slot, orderId } for orders that just got marked paid and are
// waiting for the ESP32 to dispense them. Decoupled from *who* created the
// order (webpage, button, serial) — anything that pays gets queued here.
const pendingDispense = [];

app.post('/create-order', async (req, res) => {
  try {
    const { amount, slot } = req.body;
    if (!amount || !slot) {
      return res.status(400).json({ error: 'amount and slot are required' });
    }

    const link = await razorpay.paymentLink.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      description: `Vending machine slot ${slot}`,
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { slot },
      expire_by: Math.floor(Date.now() / 1000) + 1200, // 20 min (Razorpay requires 15 min minimum)
      options: {
        checkout: {
          config: {
            display: {
              hide: [
                { method: 'card' },
                { method: 'netbanking' },
                { method: 'wallet' },
                { method: 'emi' },
                { method: 'paylater' },
                { method: 'cardless_emi' },
                { method: 'app' },
              ],
            },
          },
        },
      },
    });

    const orderId = link.id;
    orders[orderId] = {
      linkId: link.id,
      amount,
      slot,
      status: 'pending',
      createdAt: Date.now(),
    };

    const qrImageDataUrl = await QRCode.toDataURL(link.short_url);

    res.json({
      orderId,
      paymentUrl: link.short_url,
      imageUrl: qrImageDataUrl,
      expiresAt: link.expire_by,
    });
  } catch (err) {
    console.error('create-order error:', err);
    res.status(500).json({ error: 'failed to create order' });
  }
});

app.post('/webhook', (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');

  if (signature !== expected) {
    console.warn('Webhook signature mismatch — ignoring request');
    return res.status(400).json({ error: 'invalid signature' });
  }

  const event = req.body.event;

  if (event === 'payment_link.paid') {
    const linkId = req.body.payload.payment_link.entity.id;
    const order = Object.values(orders).find(o => o.linkId === linkId);

    if (order && order.status === 'pending') {
      order.status = 'paid';
      console.log(`Order for slot ${order.slot} marked PAID (link: ${linkId})`);
      pendingDispense.push({ slot: order.slot, orderId: linkId });
    }
  }

  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// GET /pending-dispense
// The ESP32 polls this on a timer. Returns any newly-paid orders waiting to
// be dispensed, then clears the queue (drain-on-read — assumes one machine
// consuming it). Each entry is { slot, orderId }.
// ---------------------------------------------------------------------------
app.get('/pending-dispense', (req, res) => {
  const items = pendingDispense.splice(0, pendingDispense.length); // drain the queue
  res.json({ items });
});

app.get('/check-status', (req, res) => {
  const { order_id } = req.query;
  const order = orders[order_id];

  if (!order) {
    return res.status(404).json({ status: 'not_found' });
  }

  if (order.status === 'pending' && Date.now() - order.createdAt > 20 * 60 * 1000) {
    order.status = 'expired';
  }

  res.json({ status: order.status, slot: order.slot, amount: order.amount });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vending payment server running on port ${PORT}`));
