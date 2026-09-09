const { MongoClient } = require("mongodb");

const email = process.argv[2];

if (!email) {
  console.error("Please provide a user email.");
  console.error("Example: node scripts/make-admin.js user@example.com");
  process.exit(1);
}

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error("MONGODB_URI is not configured.");
  process.exit(1);
}

async function makeAdmin() {
  const client = new MongoClient(uri);

  try {
    await client.connect();

    const database = client.db(housing_agent);
    const users = database.collection("users");

    const result = await users.updateOne(
      { email: email.toLowerCase() },
      { $set: { role: "admin" } }
    );

    if (result.matchedCount === 1) {
      console.log(`✅ ${email} has been granted admin rights.`);
    } else {
      console.log(`❌ No user found with email: ${email}`);
    }
  } catch (error) {
    console.error("Error making user admin:", error);
  } finally {
    await client.close();
  }
}

makeAdmin();