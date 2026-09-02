require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const app = express();

// IMPORTANT: the webhook route needs the raw body (for signature verification),
// so we capture it with a verify callback before JSON parsing runs.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// In-memory order store — swap for a real DB (SQLite/Postgres) once you're
// running more than one machine or need orders to survive a server restart.
// Shape: { orderId: { qrId, amount, slot, status, createdAt } }
const orders = {};

// ---------------------------------------------------------------------------
// 1. POST /create-order
// Machine calls this when the user picks an item. We create a single-use
// Razorpay UPI QR code for that exact amount and hand back the image URL
// plus our own orderId for polling.
// ---------------------------------------------------------------------------
app.post('/create-order', async (req, res) => {
  try {
    const { amount, slot } = req.body; // amount in RUPEES from the machine
    if (!amount || !slot) {
      return res.status(400).json({ error: 'amount and slot are required' });
    }

    const qr = await razorpay.qrCode.create({
      type: 'upi_qr',
      name: `Vending Slot ${slot}`,
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: Math.round(amount * 100), // paise
      description: `Vending machine slot ${slot}`,
      close_by: Math.floor(Date.now() / 1000) + 300, // expires in 5 min
    });

    const orderId = qr.id; // we just reuse Razorpay's QR id as our order id
    orders[orderId] = {
      qrId: qr.id,
      amount,
      slot,
      status: 'pending',
      createdAt: Date.now(),
    };

    res.json({
      orderId,
      imageUrl: qr.image_url,
      expiresAt: qr.close_by,
    });
  } catch (err) {
    console.error('create-order error:', err);
    res.status(500).json({ error: 'failed to create order' });
  }
});

// ---------------------------------------------------------------------------
// 2. POST /webhook
// Razorpay calls this automatically when the QR is paid. We MUST verify the
// signature — otherwise anyone could POST a fake "paid" event.
// ---------------------------------------------------------------------------
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

  if (event === 'qr_code.credited') {
    const qrId = req.body.payload.qr_code.entity.id;
    const order = Object.values(orders).find(o => o.qrId === qrId);

    if (order && order.status === 'pending') {
      order.status = 'paid';
      console.log(`Order for slot ${order.slot} marked PAID (qr: ${qrId})`);

      // Close the QR so it can't be paid again / reused.
      razorpay.qrCode.close(qrId).catch(err =>
        console.error('failed to close qr code:', err)
      );
    }
  }

  // Always 200 quickly — Razorpay retries if you don't ack.
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// 3. GET /check-status?order_id=X
// Machine polls this every 2-3 seconds while showing the QR.
// ---------------------------------------------------------------------------
app.get('/check-status', (req, res) => {
  const { order_id } = req.query;
  const order = orders[order_id];

  if (!order) {
    return res.status(404).json({ status: 'not_found' });
  }

  // Treat orders older than 5 minutes with no payment as expired.
  if (order.status === 'pending' && Date.now() - order.createdAt > 5 * 60 * 1000) {
    order.status = 'expired';
  }

  res.json({ status: order.status, slot: order.slot, amount: order.amount });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vending payment server running on port ${PORT}`));
