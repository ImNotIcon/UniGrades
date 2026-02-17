const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, 'client.log');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function start() {
    const timestamp = new Date().toISOString();
    logStream.write(`\n--- Client Started at ${timestamp} ---\n`);
    console.log(`[Manager] Starting client... Logs at ${logPath}`);

    // Using npx vite to avoid dependency issues, or npm run dev
    const isWin = process.platform === 'win32';
    const client = spawn(isWin ? 'npm.cmd run dev' : 'npm run dev', [], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
    });

    client.stdout.on('data', (data) => {
        logStream.write(data);
        process.stdout.write(data);
    });

    client.stderr.on('data', (data) => {
        logStream.write(data);
        process.stderr.write(data);
    });

    client.on('exit', (code) => {
        const exitTime = new Date().toISOString();
        const msg = `[Manager] Client exited with code ${code} at ${exitTime}. Restarting in 2 seconds...\n`;
        logStream.write(msg);
        console.log(msg);
        setTimeout(start, 2000);
    });
}

start();
