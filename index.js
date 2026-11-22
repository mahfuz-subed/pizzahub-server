import express from "express";
import cors from "cors";
import "dotenv/config";
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

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.post("/add-menu", async (req, res) => {
  const { vendorId, ...data } = req.body;

  if (!vendorId || !ObjectId.isValid(vendorId)) {
    return res.status(400).send({ error: "A valid vendor id is required." });
  }

  const result = await menuCollection.insertOne({
    ...data,
    vendorId: new ObjectId(vendorId),
  });
  res.send(result);
});

app.get("/menu", async (req, res) => {
  const result = await menuCollection
    .aggregate([
      { $match: { status: "approved" } },
      {
        $lookup: {
          from: "user",
          localField: "vendorId",
          foreignField: "_id",
          as: "vendor",
        },
      },
      { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
      { $sort: { createdAt: -1 } },
    ])
    .toArray();
  res.send(result);
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

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
