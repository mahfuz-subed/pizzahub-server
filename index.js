import express from "express";
import cors from "cors";
import "dotenv/config";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = 5000;

app.use(cors());
app.use(express.json());

import { MongoClient, ObjectId } from "mongodb";
const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const mongoClient = await connectToMongoDB();
const db = mongoClient.db("pizzahubDB");
const menuCollection = db.collection("menu");
const orderCollection = db.collection("orders");
const paymentsCollection = db.collection("payments");
// Better Auth stores users in the singular "user" collection.
const usersCollection = db.collection("user");

app.get("/", (req, res) => {
  res.send("Hello World!");
});

// //users related apis
// app.get("users/:id/premium", async (req, res) => {
//   const id = req.params.id;
//   const result = await usersCollection.findOne(
//     { _id: new ObjectId(id) },
//     { projection: { premium: 1 } },
//   );
//   res.send(result);
// });

//menu related apis
app.post("/add-menu", async (req, res) => {
  // Pick only the fields we expect. Spreading req.body would let a client
  // inject anything (including status) into the saved document.
  const {
    vendorId,
    vendorName,
    vendorBusinessName,
    itemName,
    category,
    description,
    price,
    location,
    images,
  } = req.body;

  if (!vendorId || !ObjectId.isValid(vendorId)) {
    return res.status(400).send({ error: "A valid vendor id is required." });
  }
  if (!itemName || !category || !description || !location || !(price > 0)) {
    return res.status(400).send({ error: "Please fill in all item fields." });
  }

  const result = await menuCollection.insertOne({
    vendorId: new ObjectId(vendorId),
    vendorName: vendorName ?? "Local vendor",
    vendorBusinessName: vendorBusinessName ?? null,
    itemName,
    category,
    description,
    price,
    location,
    images: Array.isArray(images) ? images : [],
    // Temporary: there is no admin approval yet, so new items go live right away.
    // Change this back to "pending" once the admin review flow exists.
    status: "approved",
    createdAt: new Date(),
  });
  res.send(result);
});
// How many ACTIVE items a vendor already has (used for the 3-item Free limit).
app.get("/add-menu/count", async (req, res) => {
  // Accept the id from the query string or the body, whichever the client sends.
  const vendorId = req.query.vendorId ?? req.body?.vendorId;

  if (typeof vendorId !== "string" || !ObjectId.isValid(vendorId)) {
    return res.status(400).send({ error: "A valid vendorId is required." });
  }

  const result = await menuCollection.countDocuments({
    vendorId: new ObjectId(vendorId),
    status: "approved",
  });
  res.send({ count: result });
});

app.get("/menu", async (req, res) => {
  const query = { status: "approved" };

  if (typeof req.query.category === "string" && req.query.category) {
    query.category = req.query.category;
  }
  if (typeof req.query.location === "string" && req.query.location) {
    query.location = { $regex: req.query.location, $options: "i" };
  }
  if (typeof req.query.search === "string" && req.query.search) {
    query.$or = [
      { itemName: { $regex: req.query.search, $options: "i" } },
      { description: { $regex: req.query.search, $options: "i" } },
      { category: { $regex: req.query.search, $options: "i" } },
      { location: { $regex: req.query.search, $options: "i" } },
      { vendorName: { $regex: req.query.search, $options: "i" } },
      { vendorBusinessName: { $regex: req.query.search, $options: "i" } },
    ];
  }

  const sort =
    req.query.sort === "price_asc"
      ? { price: 1 }
      : req.query.sort === "price_desc"
        ? { price: -1 }
        : { createdAt: -1 };

  const result = await menuCollection.find(query).sort(sort).toArray();
  res.send(result);
});

// One approved item for the details page.
app.get("/menuDetails/:id", async (req, res) => {
  const { id } = req.params;

  // Return 404 (not 400) so the page shows its friendly "not found" message.
  if (!ObjectId.isValid(id)) {
    return res.status(404).send({ error: "Menu item not found." });
  }

  const item = await menuCollection.findOne({
    _id: new ObjectId(id),
    status: "approved",
  });

  if (!item) {
    return res.status(404).send({ error: "Menu item not found." });
  }

  res.send(item);
});

app.get("/my-menu-items", async (req, res) => {
  const vendorId = req.query.vendorId;
  if (
    typeof vendorId !== "string" ||
    !vendorId ||
    !ObjectId.isValid(vendorId)
  ) {
    return res.status(400).json({ error: "A valid vendorId is required." });
  }

  const result = await menuCollection
    .find({ vendorId: new ObjectId(vendorId) })
    .sort({ createdAt: -1 }) // newest first
    .toArray();

  res.json(result);
});

// GET /menu/categories  -  how many approved items each category has
app.get("/menu/categories", async (req, res) => {
  try {
    const counts = await menuCollection
      .aggregate([
        { $match: { status: "approved" } },

        { $group: { _id: "$category", count: { $sum: 1 } } },
      ])
      .toArray();

    res.send(counts);
  } catch {
    res.status(500).send({ error: "Could not load categories." });
  }
});

// Update a menu item (also used to toggle availability via "status")
app.put("/update-menu-item/:id", async (req, res) => {
  const { vendorId, ...updates } = req.body;

  if (
    !vendorId ||
    !ObjectId.isValid(vendorId) ||
    !ObjectId.isValid(req.params.id)
  ) {
    return res
      .status(400)
      .send({ error: "A valid vendor id and item id are required." });
  }

  // Vendors may only mark items approved (available) or inactive (unavailable).
  // They cannot approve a pending item or change it to rejected.
  if (updates.status && !["approved", "inactive"].includes(updates.status)) {
    return res.status(400).send({ error: "You cannot set that status." });
  }

  const item = await menuCollection.findOne({
    _id: new ObjectId(req.params.id),
  });
  if (!item) {
    return res.status(404).send({ error: "Menu item not found." });
  }
  if (String(item.vendorId) !== vendorId) {
    return res.status(403).send({ error: "This item does not belong to you." });
  }

  const allowed = [
    "itemName",
    "category",
    "description",
    "price",
    "location",
    "images",
    "status",
  ];
  const changes = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) changes[key] = updates[key];
  }

  await menuCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: changes },
  );
  res.send({ message: "Menu item updated." });
});

// Delete a menu item
app.delete("/delete-menu-item/:id", async (req, res) => {
  const vendorId = req.query.vendorId;

  if (
    typeof vendorId !== "string" ||
    !vendorId ||
    !ObjectId.isValid(vendorId) ||
    !ObjectId.isValid(req.params.id)
  ) {
    return res
      .status(400)
      .send({ error: "A valid vendor id and item id are required." });
  }

  const item = await menuCollection.findOne({
    _id: new ObjectId(req.params.id),
  });
  if (!item) {
    return res.status(404).send({ error: "Menu item not found." });
  }
  if (String(item.vendorId) !== vendorId) {
    return res.status(403).send({ error: "This item does not belong to you." });
  }

  await menuCollection.deleteOne({ _id: new ObjectId(req.params.id) });
  res.send({ message: "Menu item deleted." });
});

// order related apis
app.post("/orders", async (req, res) => {
  try {
    const order = req.body;

    // Stop a customer from ordering the same item twice for the same date
    // while an earlier order is still active (pending or accepted).
    const existing = await orderCollection.findOne({
      customerId: order.customerId,
      itemId: order.itemId,
      deliveryDate: order.deliveryDate,
      status: { $in: ["pending", "accepted"] },
    });
    if (existing) {
      return res.status(409).send({
        error: "You already have an active order for this item and date.",
      });
    }

    const result = await orderCollection.insertOne(order);
    res.send(result);
  } catch (error) {
    // Always answer with JSON so the client shows a readable message
    // instead of trying to parse an HTML error page.
    res.status(500).send({ error: "Could not save your order." });
  }
});

// Orders belonging to one customer, newest first.
app.get("/my-orders", async (req, res) => {
  const customerId = req.query.customerId;
  if (typeof customerId !== "string" || !customerId) {
    return res.status(400).send({ error: "A customerId is required." });
  }

  const result = await orderCollection
    .find({ customerId })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(result);
});

// A customer can cancel only their own pending order.
app.put("/cancel-order/:id", async (req, res) => {
  const { customerId } = req.body ?? {};
  const { id } = req.params;

  if (!customerId || !ObjectId.isValid(id)) {
    return res.status(400).send({ error: "Invalid order request." });
  }

  const order = await orderCollection.findOne({ _id: new ObjectId(id) });
  if (!order) {
    return res.status(404).send({ error: "Order not found." });
  }
  if (order.customerId !== customerId) {
    return res
      .status(403)
      .send({ error: "This order does not belong to you." });
  }
  if (order.status !== "pending") {
    return res
      .status(400)
      .send({ error: "Only pending orders can be cancelled." });
  }

  await orderCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: "cancelled" } },
  );
  res.send({ message: "Order cancelled." });
});

//payments related apis
app.post("/payments/checkout-verify", async (req, res) => {
  const { sessionId } = req.body;

  // No session id -> fail early with JSON.
  if (typeof sessionId !== "string" || !sessionId) {
    return res
      .status(400)
      .send({ success: false, message: "A sessionId is required." });
  }

  try {
    const {
      status,
      payment_status,
      customer_details,
      metadata,
      payment_intent,
    } = await stripe.checkout.sessions.retrieve(sessionId);

    // userId lives inside metadata, and may be missing -> guard it.
    const userId = metadata?.userId;

    if (status === "complete" && payment_status === "paid") {
      const sessionQuery = { sessionId };
      const existingPayment = await paymentsCollection.findOne(sessionQuery);
      if (existingPayment) {
        return res.send({
          success: false,
          message: "Payment already verified",
        });
      }
      const payment = {
        status,
        payment_status,
        customer_details,
        userId,
        payment_date: new Date(),
        payment_intent,
      };
      const result = await paymentsCollection.insertOne(payment);

      // updateOne needs TWO arguments: a filter and an update document.
      // Activate Premium using the field the rest of the app reads.
      const updatedResult = await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { subscriptionPlan: "premium" } },
      );

      // return -> stop here so the fallback below does not also run.
      return res.send({ success: true, result, updatedResult });
    }

    // Session exists but is not paid/complete: answer instead of hanging.
    return res.send({
      success: false,
      message: "Payment verification failed.",
    });
  } catch (error) {
    return res
      .status(500)
      .send({ success: false, message: "Could not verify the payment." });
  }
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

export default app;
