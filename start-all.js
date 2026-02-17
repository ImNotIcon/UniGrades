const { spawn } = require('child_process');
const path = require('path');

console.log('--- UniGrades Universal Starter ---');

function run(dir, name) {
    const shell = process.platform === 'win32';
    const proc = spawn('node', ['start.js'], {
        cwd: path.join(__dirname, dir),
        stdio: 'inherit',
        shell: shell
    });

    proc.on('exit', (code) => {
        console.log(`[System] ${name} manager stopped (Code: ${code})`);
    });

    return proc;
}

const server = run('server', 'Server');
const client = run('client', 'Client');

process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.kill();
    client.kill();
    process.exit();
});
