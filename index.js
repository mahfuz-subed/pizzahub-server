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
import { createRemoteJWKSet, jwtVerify } from "jose";
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

const transactionsCollection = db.collection("transactions");

const usersCollection = db.collection("user");

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
);

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "Unauthorized" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);

    // payload.sub is the user id Better Auth put inside the token.
    const user = await usersCollection.findOne({
      _id: new ObjectId(payload.sub),
    });
    if (!user || user.isBlocked) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).send({ message: "Unauthorized" });
  }
};

// Must be used AFTER verifyToken, which sets req.user.
const verifyAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).send({ message: "Forbidden" });
  }
  next();
};

// Same pattern for the other two roles.
const verifyVendor = async (req, res, next) => {
  if (req.user?.role !== "vendor") {
    return res.status(403).send({ message: "Forbidden" });
  }

  // Expired Premium falls back to Free on the next vendor request.
  const expiresAt = req.user.subscriptionExpiresAt;
  if (
    req.user.subscriptionPlan === "premium" &&
    expiresAt &&
    new Date(expiresAt) < new Date()
  ) {
    await usersCollection.updateOne(
      { _id: req.user._id },
      { $set: { subscriptionPlan: "free" } },
    );
    req.user.subscriptionPlan = "free";
  }

  next();
};

const verifyCustomer = (req, res, next) => {
  if (req.user?.role !== "customer") {
    return res.status(403).send({ message: "Forbidden" });
  }
  next();
};

app.get("/", (req, res) => {
  res.send("Hello World!");
});

//users related apis
app.get("/users/:id/premium", async (req, res) => {
  const id = req.params.id;
  const result = await usersCollection.findOne(
    { _id: new ObjectId(id) },
    { projection: { subscriptionPlan: 1 } },
  );
  res.send(result);
});

// Ids of vendors with a Premium subscription - used for the homepage badge
// and to put their items first in the featured section.
app.get("/premium-vendors", async (req, res) => {
  const result = await usersCollection
    .find({ subscriptionPlan: "premium" }, { projection: { _id: 1 } })
    .toArray();
  res.send(result.map((user) => String(user._id)));
});

//menu related apis
app.post("/add-menu", verifyToken, verifyVendor, async (req, res) => {
  // Pick only the fields we expect. Spreading req.body would let a client
  // inject anything (including status) into the saved document.
  const {
    vendorName,
    vendorBusinessName,
    itemName,
    category,
    description,
    price,
    location,
    images,
  } = req.body;

  if (!itemName || !category || !description || !location || !(price > 0)) {
    return res.status(400).send({ error: "Please fill in all item fields." });
  }

  const result = await menuCollection.insertOne({
    // Ownership comes from the verified token, never from the request body.
    vendorId: req.user._id,
    vendorName: vendorName ?? "Local vendor",
    vendorBusinessName: vendorBusinessName ?? null,
    itemName,
    category,
    description,
    price,
    location,
    images: Array.isArray(images) ? images : [],
    // New items wait for admin approval before they appear publicly.
    status: "pending",
    createdAt: new Date(),
  });
  res.send(result);
});
// How many ACTIVE items a vendor already has (used for the 3-item Free limit).
app.get("/add-menu/count", verifyToken, verifyVendor, async (req, res) => {
  // The vendor is the verified user - no id is trusted from the URL.
  const result = await menuCollection.countDocuments({
    $or: [{ vendorId: String(req.user._id) }, { vendorId: req.user._id }],
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

app.get("/my-menu-items", verifyToken, verifyVendor, async (req, res) => {
  const result = await menuCollection
    .find({
      $or: [{ vendorId: String(req.user._id) }, { vendorId: req.user._id }],
    })
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
app.put(
  "/update-menu-item/:id",
  verifyToken,
  verifyVendor,
  async (req, res) => {
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
      return res
        .status(403)
        .send({ error: "This item does not belong to you." });
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
  },
);

// Delete a menu item
app.delete(
  "/delete-menu-item/:id",
  verifyToken,
  verifyVendor,
  async (req, res) => {
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
      return res
        .status(403)
        .send({ error: "This item does not belong to you." });
    }

    await menuCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.send({ message: "Menu item deleted." });
  },
);

// Orders received by one vendor, newest first.
app.get("/vendor-orders", verifyToken, verifyVendor, async (req, res) => {
  // Stored vendorId is a string (older orders) or ObjectId (new ones).
  const result = await orderCollection
    .find({
      $or: [{ vendorId: String(req.user._id) }, { vendorId: req.user._id }],
    })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(result);
});

app.patch(
  "/update-order-status/:id",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    const { status } = req.body;

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).send({ error: "Invalid order request." });
    }
    if (!["accepted", "rejected"].includes(status)) {
      return res.status(400).send({ error: "You cannot set that status." });
    }

    // This only matches an order that is THIS vendor's AND still pending.
    // vendorId comes from the token, not the request body.
    const query = {
      _id: new ObjectId(req.params.id),
      $or: [{ vendorId: String(req.user._id) }, { vendorId: req.user._id }],
      status: "pending",
    };
    const result = await orderCollection.updateOne(query, {
      $set: { status: status },
    });

    // matchedCount = how many orders matched the whole query
    if (result.matchedCount === 0) {
      return res.status(409).send({
        error:
          "This order cannot be updated. It belongs to another vendor, or it was already decided.",
      });
    }
    res.send({ message: `Order ${status}.` });
  },
);

// order related apis
app.post("/orders", verifyToken, verifyCustomer, async (req, res) => {
  try {
    // customerId comes from the token, never from the request body.
    const order = { ...req.body, customerId: req.user._id };

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
app.get("/my-orders", verifyToken, verifyCustomer, async (req, res) => {
  // customerId is a string in seeded orders and an ObjectId in newer ones.
  const result = await orderCollection
    .find({
      $or: [{ customerId: String(req.user._id) }, { customerId: req.user._id }],
    })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(result);
});

// A customer can cancel only their own pending order.
app.put("/cancel-order/:id", verifyToken, verifyCustomer, async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ error: "Invalid order request." });
  }

  const order = await orderCollection.findOne({ _id: new ObjectId(id) });
  if (!order) {
    return res.status(404).send({ error: "Order not found." });
  }
  // Ownership comes from the verified token. Stored customerId may be a
  // string (seeded orders) or an ObjectId (orders created in the app).
  if (String(order.customerId) !== String(req.user._id)) {
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
app.post("/payments/checkout-verify", verifyToken, async (req, res) => {
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
      subscription,
    } = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    // userId lives inside metadata, and may be missing -> guard it.
    const userId = metadata?.userId;

    // subscription.current_period_end tells us when Premium expires.
    let expiresAt = null;
    const periodEnd = subscription?.items?.data?.[0]?.current_period_end;
    if (periodEnd) {
      expiresAt = new Date(periodEnd * 1000);
    }

    if (status === "complete" && payment_status === "paid") {
      // Idempotency: one transaction per Stripe session.
      const existing = await transactionsCollection.findOne({
        stripeSessionId: sessionId,
      });
      if (existing) {
        return res.send({
          success: false,
          message: "Payment already verified",
        });
      }

      const transaction = {
        vendorId: String(userId),
        plan: "premium",
        amount: session.amount_total ?? null,
        currency: session.currency ?? null,
        stripeSessionId: sessionId,
        stripeSubscriptionId:
          typeof subscription === "string"
            ? subscription
            : (subscription?.id ?? null),
        status: payment_status,
        createdAt: new Date(),
      };
      const result = await transactionsCollection.insertOne(transaction);

      // updateOne needs TWO arguments: a filter and an update document.
      // Activate Premium using the field the rest of the app reads.
      const updatedResult = await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        {
          $set: {
            subscriptionPlan: "premium",
            subscriptionExpiresAt: expiresAt,
          },
        },
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

// Admin APIs - every one checks the JWT first, then the admin role.

// Overview numbers for the admin dashboard.
app.get("/admin/overview", verifyToken, verifyAdmin, async (req, res) => {
  const [users, vendors, customers, menuItems, pending, transactions] =
    await Promise.all([
      usersCollection.countDocuments({}),
      usersCollection.countDocuments({ role: "vendor" }),
      usersCollection.countDocuments({ role: "customer" }),
      menuCollection.countDocuments({}),
      menuCollection.countDocuments({ status: "pending" }),
      transactionsCollection.countDocuments({}),
    ]);

  res.send({
    users,
    vendors,
    customers,
    menuItems,
    pending,
    transactions,
  });
});

// Manage users: optional ?search= and ?role= filters.
app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
  const query = {};
  if (typeof req.query.search === "string" && req.query.search) {
    query.$or = [
      { name: { $regex: req.query.search, $options: "i" } },
      { email: { $regex: req.query.search, $options: "i" } },
    ];
  }
  if (typeof req.query.role === "string" && req.query.role) {
    query.role = req.query.role;
  }

  const result = await usersCollection.find(query).toArray();
  res.send(result);
});

// Change a user's role. Admin role cannot be assigned here.
app.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
  const { role } = req.body;
  if (!["vendor", "customer"].includes(role)) {
    return res.status(400).send({ error: "Invalid role." });
  }
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({ error: "Invalid user id." });
  }

  const result = await usersCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { role } },
  );
  res.send(result);
});

//block / unblock a user.
app.patch("/users/:id/block", verifyToken, verifyAdmin, async (req, res) => {
  const { isBlocked } = req.body;
  if (typeof isBlocked !== "boolean" || !ObjectId.isValid(req.params.id)) {
    return res.status(400).send({ error: "Invalid request." });
  }

  const result = await usersCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { isBlocked } },
  );
  res.send(result);
});

// Manage menu items:  ?search=, ?status= and ?category= filters.
app.get("/admin/menu-items", verifyToken, verifyAdmin, async (req, res) => {
  const query = {};
  if (typeof req.query.status === "string" && req.query.status) {
    query.status = req.query.status;
  }
  if (typeof req.query.category === "string" && req.query.category) {
    query.category = req.query.category;
  }
  if (typeof req.query.search === "string" && req.query.search) {
    query.itemName = { $regex: req.query.search, $options: "i" };
  }

  const result = await menuCollection.find(query).toArray();
  res.send(result);
});

// Approve / reject / change availability of a published item.
app.patch(
  "/admin/menu-items/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { status } = req.body;
    if (!["approved", "rejected", "inactive"].includes(status)) {
      return res.status(400).send({ error: "Invalid status." });
    }
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).send({ error: "Invalid item id." });
    }

    const result = await menuCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status } },
    );
    res.send(result);
  },
);

// Delete an inappropriate item.
app.delete(
  "/admin/menu-items/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).send({ error: "Invalid item id." });
    }

    const result = await menuCollection.deleteOne({
      _id: new ObjectId(req.params.id),
    });
    res.send(result);
  },
);

// Transactions - read only, admins cannot edit payment records.
app.get("/admin/transactions", verifyToken, verifyAdmin, async (req, res) => {
  const result = await transactionsCollection.find().toArray();
  res.send(result);
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

export default app;
