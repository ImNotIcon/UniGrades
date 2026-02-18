const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('dotenv').config();

const DB_NAME = 'unigrades';
const COLLECTIONS = ['subscriptions', 'statistics'];
const ENV_FILE = path.join(__dirname, '.env');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function prompt(question) {
    return new Promise((resolve) => rl.question(question, resolve));
}

async function setup() {
    console.log('--- UniGrades MongoDB Setup ---');

    let mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
        console.log('\nMONGODB_URI not found in .env');
        mongoUri = await prompt('Enter your MongoDB URI (default: mongodb://localhost:27017): ');
        if (!mongoUri.trim()) {
            mongoUri = 'mongodb://localhost:27017';
        }
    }

    const client = new MongoClient(mongoUri, {
        connectTimeoutMS: 5000,
        serverSelectionTimeoutMS: 5000
    });

    try {
        console.log(`\nConnecting to MongoDB at: ${mongoUri}...`);
        await client.connect();
        console.log('✅ Connected successfully!');

        const db = client.db(DB_NAME);

        for (const colName of COLLECTIONS) {
            const collections = await db.listCollections({ name: colName }).toArray();
            if (collections.length === 0) {
                console.log(`Creating collection: ${colName}...`);
                await db.createCollection(colName);
                console.log(`✅ Collection "${colName}" created.`);
            } else {
                console.log(`ℹ️ Collection "${colName}" already exists.`);
            }
        }

        // --- subscriptions indexes ---
        const subCol = db.collection('subscriptions');
        console.log('\nConfiguring subcriptions indexes...');
        // _id is the username, primary key.
        await subCol.createIndex({ updatedAt: -1 });
        // Index for device lookup (multikey index)
        await subCol.createIndex({ "subscriptions.deviceId": 1 });
        console.log('✅ Subscriptions indexes verified.');

        // --- statistics indexes ---
        const statsCol = db.collection('statistics');
        console.log('\nConfiguring statistics indexes...');
        await statsCol.createIndex({ updatedAt: -1 });
        // Index for device metadata lookup
        await statsCol.createIndex({ "devices.deviceId": 1 });
        console.log('✅ Statistics indexes verified.');

        // Update .env if MONGODB_URI was missing or changed
        let envContent = '';
        if (fs.existsSync(ENV_FILE)) {
            envContent = fs.readFileSync(ENV_FILE, 'utf8');
        }

        if (!envContent.includes('MONGODB_URI=')) {
            console.log('\nUpdating .env file with MONGODB_URI...');
            const newEnvLine = `\n# MongoDB Configuration\nMONGODB_URI=${mongoUri}\n`;
            fs.appendFileSync(ENV_FILE, newEnvLine);
            console.log('✅ .env updated.');
        } else if (process.env.MONGODB_URI !== mongoUri) {
            // Handle case where they entered a different URI than what was in .env (optional logic)
            console.log('\nℹ️ Note: .env already has a MONGODB_URI. If you want to change it, please edit .env manually.');
        }

        console.log('\n--- Setup Complete! ---');
        console.log('You can now run the server with MongoDB support enabled.');

    } catch (error) {
        console.error('\n❌ Setup failed:');
        console.error(error.message);
        if (error.message.includes('ECONNREFUSED')) {
            console.log('\nTIP: Make sure your MongoDB service is running!');
            console.log('On Windows, check "Services" for "MongoDB Server".');
        }
    } finally {
        await client.close();
        rl.close();
    }
}

setup();
