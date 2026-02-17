const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, 'server.log');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function start() {
    const timestamp = new Date().toISOString();
    logStream.write(`\n--- Server Started at ${timestamp} ---\n`);
    console.log(`[Manager] Starting server... Logs at ${logPath}`);

    const server = spawn('node', ['index.js'], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '--dns-result-order=ipv6first' }
    });

    server.stdout.on('data', (data) => {
        logStream.write(data);
        process.stdout.write(data);
    });

    server.stderr.on('data', (data) => {
        logStream.write(data);
        process.stderr.write(data);
    });

    server.on('exit', (code) => {
        const exitTime = new Date().toISOString();
        const msg = `[Manager] Server exited with code ${code} at ${exitTime}. Restarting in 2 seconds...\n`;
        logStream.write(msg);
        console.log(msg);
        setTimeout(start, 2000);
    });
}

start();
