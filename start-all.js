const { spawn } = require('child_process');
const path = require('path');

console.log('--- UniGrades Universal Starter ---');

function run(dir, name, file = 'start.js') {
    const proc = spawn('node', [file], {
        cwd: path.join(__dirname, dir),
        stdio: 'inherit'
    });

    proc.on('exit', (code) => {
        console.log(`[System] ${name} manager stopped (Code: ${code})`);
    });

    return proc;
}

const server = run('server', 'Server');
const client = run('client', 'Client', 'start.cjs');

process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.kill();
    client.kill();
    process.exit();
});
