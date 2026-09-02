require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const QRCode = require('qrcode');

const app = express();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const orders = {};

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
      // NOTE: once UPI is activated on the account, re-add the "options.checkout.config.display.hide"
      // block here (see project history) to restrict checkout to UPI only.
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
    }
  }

  res.json({ status: 'ok' });
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
