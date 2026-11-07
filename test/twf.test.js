'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const twf = require('../src/twf.js');

test('bare ending means find', () => {
    const o = twf.parseCli(['abc']);
    assert.equal(o.command, 'find');
    assert.deepEqual(o.args, ['abc']);
    assert.equal(o.wallet, 'v4r2');
    assert.equal(o.workers, 'auto');
    assert.equal(o.count, 1);
});

test('leading "twf" is ignored', () => {
    assert.equal(twf.parseCli(['twf', 'find', 'abc']).command, 'find');
    assert.equal(twf.parseCli(['twf', 'bench']).command, 'bench');
});

test('flags are parsed and validated', () => {
    const o = twf.parseCli(['find', 'Ton', '-w', 'v5r1', '-j', '8', '-n', '3', '--print-secret']);
    assert.equal(o.wallet, 'v5r1');
    assert.equal(o.workers, 8);
    assert.equal(o.count, 3);
    assert.equal(o.printSecret, true);
    assert.throws(() => twf.parseCli(['abc', '-w', 'v9']), twf.UsageError);
    assert.throws(() => twf.parseCli(['abc', '-j', '0']), twf.UsageError);
    assert.throws(() => twf.parseCli(['abc', '-n', '1.5']), twf.UsageError);
    assert.throws(() => twf.parseCli(['abc', '--nope']), twf.UsageError);
});

test('ending validation', () => {
    assert.throws(() => twf.parseCli(['a!b']), twf.UsageError);
    assert.throws(() => twf.parseCli(['find', 'x'.repeat(47)]), twf.UsageError);
    assert.doesNotThrow(() => twf.parseCli(['find', 'a-b_C9']));
    assert.throws(() => twf.parseCli(['find']), twf.UsageError);
    assert.throws(() => twf.parseCli(['find', 'a', 'b']), twf.UsageError);
});

test('environment variables are defaults, flags win', () => {
    const env = { TWF_ENDING: 'xyz', TWF_WALLET: 'v3r2', TWF_WORKERS: '4', TWF_COUNT: '2' };
    const o = twf.parseCli([], env);
    assert.equal(o.command, 'find');
    assert.deepEqual(o.args, ['xyz']);
    assert.equal(o.wallet, 'v3r2');
    assert.equal(o.workers, 4);
    assert.equal(o.count, 2);
    assert.equal(twf.parseCli(['-w', 'v5r1'], env).wallet, 'v5r1');
    assert.equal(twf.parseCli([]).command, 'help');
});

test('commands that take no arguments reject extras', () => {
    assert.throws(() => twf.parseCli(['bench', 'x']), twf.UsageError);
    assert.equal(twf.parseCli(['estimate', '4', '-r', '300']).rate, 300);
    assert.throws(() => twf.parseCli(['estimate']), twf.UsageError);
});

test('cgroup CPU limits', () => {
    assert.equal(twf.parseCpuMax('3200000 100000\n'), 32);
    assert.equal(twf.parseCpuMax('150000 100000'), 2);
    assert.equal(twf.parseCpuMax('max 100000'), null);
    assert.equal(twf.parseCfs('-1', '100000'), null);
    assert.equal(twf.parseCfs('800000', '100000'), 8);

    const files = { '/sys/fs/cgroup/cpu.max': '3200000 100000' };
    assert.deepEqual(twf.detectCpus((f) => files[f] ?? null, 128), { available: 128, limit: 32, effective: 32 });
    assert.equal(twf.detectCpus(() => null, 16).effective, 16);
    const v1 = { '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '400000', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000' };
    assert.equal(twf.detectCpus((f) => v1[f] ?? null, 64).effective, 4);
});

test('probability maths', () => {
    assert.equal(twf.meanAttempts(3), 262144);
    assert.ok(Math.abs(twf.quantileAttempts(1, 0.5) - Math.LN2 * 64) < 1e-9);
    assert.ok(Math.abs(twf.probabilityDone(2, twf.quantileAttempts(2, 0.5)) - 0.5) < 1e-3);
    assert.equal(twf.probabilityDone(3, 0), 0);
});

test('formatting', () => {
    assert.equal(twf.formatDuration(0.5), '<1 s');
    assert.equal(twf.formatDuration(42), '42 s');
    assert.equal(twf.formatDuration(600), '10.0 min');
    assert.equal(twf.formatDuration(7200), '2.0 h');
    assert.equal(twf.formatDuration(86400 * 3), '3.0 days');
    assert.equal(twf.formatCount(4096), '4096');
    assert.equal(twf.formatCount(16777216), '16.8M');
    const [row] = twf.estimateRows(300, 1.12, [4]);
    assert.equal(row.attempts, '16.8M');
    assert.equal(row.mean, '15.5 h');
    assert.equal(row.cost, '$17.40');
    assert.equal('cost' in twf.estimateRows(300, null, [1])[0], false);
});

test('attempt counter swallows per-attempt lines only', () => {
    const seen = [];
    const target = { log: (...a) => seen.push(a.join(' ')) };
    const c = twf.installAttemptCounter(target);
    target.log('Trying address:', 'EQ1');
    target.log('Trying address:', 'EQ2');
    target.log('hello');
    c.restore();
    target.log('Trying address:', 'EQ3');
    assert.equal(c.attempts, 2);
    assert.deepEqual(seen, ['hello', 'Trying address: EQ3']);
});

test('main: usage errors exit with 2', async () => {
    const errors = [];
    const code = await twf.main(['a!b'], { log() {}, error: (m) => errors.push(m), env: {} });
    assert.equal(code, 2);
    assert.match(errors[0], /Invalid ending/);
});

test('main: estimate prints a table', async () => {
    const out = [];
    const code = await twf.main(['estimate', 'abc', '--rate', '100', '--price', '1'], { log: (m) => out.push(m), env: {} });
    assert.equal(code, 0);
    assert.ok(out.some((l) => l.startsWith('3 ')));
});

test('main: end-to-end find + list + decrypt (1-char ending)', { timeout: 120_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twf-test-'));
    try {
        const out = [];
        const ctx = { log: (m) => out.push(m), error: (m) => out.push(m), env: { TWF_PASSWORD: 'correct horse' } };
        assert.equal(await twf.main(['find', 'a', '-j', '2', '-o', dir], ctx), 0);
        const files = fs.readdirSync(dir);
        assert.deepEqual(files, ['ton_wallet_results.enc.json']);
        assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
        const wallet = out.find((l) => l.startsWith('Wallet:')).split(/\s+/)[1];
        assert.ok(wallet.endsWith('a'));
        assert.ok(!out.some((l) => /Words:/.test(l)), 'mnemonic must not be logged without --print-secret');

        out.length = 0;
        assert.equal(await twf.main(['decrypt', files[0], '-o', dir], ctx), 0);
        assert.ok(out[0].includes(wallet));
        assert.equal(out[1].replace('Words:', '').trim().split(' ').length, 24);

        out.length = 0;
        assert.equal(await twf.main(['decrypt', files[0], '-o', dir], { ...ctx, env: { TWF_PASSWORD: 'wrong' } }), 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
