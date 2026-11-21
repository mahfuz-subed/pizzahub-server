import express from "express";
import cors from "cors";
import "dotenv/config";
const app = express();
const port = 5000;

app.use(cors());
app.use(express.json());

import { MongoClient } from "mongodb";
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
  const data = req.body;
  const result = await menuCollection.insertOne(data);
  res.send(result);
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
