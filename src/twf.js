#!/usr/bin/env node
'use strict';

// twf — command-line wrapper around ton-wallet-finder, built for one-shot cloud pods
// (RunPod & co.): the pod's start command is the twf command line.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { TonWalletFinder, saveResultsToFile, decryptResults } = require('ton-wallet-finder');

const LIB_VERSION = require('ton-wallet-finder/package.json').version;
const IMAGE_VERSION = require('../package.json').version;

const ALPHABET_SIZE = 64;
const MAX_ENDING = 46;
const WALLETS = ['v3r2', 'v4r2', 'v5r1'];
const ENDING_RE = /^[A-Za-z0-9_-]+$/;
const COMMANDS = ['find', 'bench', 'estimate', 'decrypt', 'list', 'cores', 'help', 'version'];
// The ton-wallet-finder log line emitted per attempt when `showProcess` is on.
const ATTEMPT_LOG_PREFIX = 'Trying address:';

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const OPTIONS = {
    wallet:         { type: 'string',  short: 'w' },
    workers:        { type: 'string',  short: 'j' },
    count:          { type: 'string',  short: 'n' },
    out:            { type: 'string',  short: 'o' },
    seconds:        { type: 'string',  short: 't' },
    rate:           { type: 'string',  short: 'r' },
    price:          { type: 'string',  short: 'p' },
    progress:       { type: 'string' },
    'print-secret': { type: 'boolean' },
    help:           { type: 'boolean', short: 'h' },
};

function positiveNumber(value, name) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) { throw new UsageError(`--${name} must be a positive number, got "${value}"`); }
    return n;
}

function positiveInt(value, name) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) { throw new UsageError(`--${name} must be a positive integer, got "${value}"`); }
    return n;
}

function validateEnding(ending) {
    if (!ENDING_RE.test(ending)) {
        throw new UsageError(`Invalid ending "${ending}": only A-Z, a-z, 0-9, "-" and "_" are allowed`);
    }
    if (ending.length > MAX_ENDING) {
        throw new UsageError(`Ending is too long (${ending.length}); at most ${MAX_ENDING} characters`);
    }
    return ending;
}

/**
 * Turn argv + environment into a normalised command object. Pure: no I/O.
 * CLI flags win over environment variables (TWF_*), which win over defaults.
 */
function parseCli(argv, env = {}) {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (err) {
        throw new UsageError(err.message);
    }
    const { values, positionals } = parsed;
    const args = [...positionals];

    if (args[0] === 'twf') { args.shift(); } // tolerate "twf find abc" as the pod command

    let command;
    if (values.help) {
        command = 'help';
    } else if (args.length === 0) {
        command = env.TWF_ENDING ? 'find' : 'help';
        if (env.TWF_ENDING) { args.push(env.TWF_ENDING); }
    } else if (COMMANDS.includes(args[0])) {
        command = args.shift();
    } else {
        command = 'find'; // bare ending: "abc" == "find abc"
    }

    const wallet = values.wallet ?? env.TWF_WALLET ?? 'v4r2';
    if (!WALLETS.includes(wallet)) {
        throw new UsageError(`--wallet must be one of ${WALLETS.join(', ')}, got "${wallet}"`);
    }

    const workersRaw = values.workers ?? env.TWF_WORKERS ?? 'auto';
    const workers = workersRaw === 'auto' ? 'auto' : positiveInt(workersRaw, 'workers');

    const opts = {
        command,
        args,
        wallet,
        workers,
        count:       positiveInt(values.count ?? env.TWF_COUNT ?? '1', 'count'),
        out:         values.out ?? env.TWF_OUT ?? null,
        seconds:     positiveNumber(values.seconds ?? env.TWF_BENCH_SECONDS ?? '30', 'seconds'),
        rate:        (values.rate ?? env.TWF_RATE) ? positiveNumber(values.rate ?? env.TWF_RATE, 'rate') : null,
        price:       (values.price ?? env.TWF_PRICE_PER_HOUR)
            ? positiveNumber(values.price ?? env.TWF_PRICE_PER_HOUR, 'price') : null,
        progress:    positiveNumber(values.progress ?? env.TWF_PROGRESS ?? '60', 'progress'),
        printSecret: Boolean(values['print-secret']) || env.TWF_PRINT_SECRET === '1',
    };

    switch (command) {
        case 'find':
            if (opts.args.length !== 1) { throw new UsageError('find needs exactly one ending, e.g. "find abc"'); }
            validateEnding(opts.args[0]);
            break;
        case 'estimate':
            if (opts.args.length !== 1) { throw new UsageError('estimate needs an ending or a length, e.g. "estimate 4"'); }
            if (!/^\d+$/.test(opts.args[0])) { validateEnding(opts.args[0]); }
            break;
        case 'decrypt':
            if (opts.args.length !== 1) { throw new UsageError('decrypt needs a file, e.g. "decrypt ton_wallet_results.enc.json"'); }
            break;
        default:
            if (opts.args.length > 0) { throw new UsageError(`Unexpected argument "${opts.args[0]}" for ${command}`); }
    }
    return opts;
}

// ---------------------------------------------------------------------------
// CPU detection (containers often see all host CPUs but are limited by a cgroup quota)
// ---------------------------------------------------------------------------

/** Parse cgroup v2 `cpu.max` ("<quota> <period>" or "max <period>"). */
function parseCpuMax(text) {
    const [quota, period] = String(text).trim().split(/\s+/);
    if (!quota || quota === 'max' || !period) { return null; }
    const n = Math.ceil(Number(quota) / Number(period));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse cgroup v1 cfs_quota_us / cfs_period_us. */
function parseCfs(quotaText, periodText) {
    const quota = Number(String(quotaText).trim());
    const period = Number(String(periodText).trim());
    if (!(quota > 0) || !(period > 0)) { return null; }
    return Math.ceil(quota / period);
}

function readOrNull(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function detectCpus(read = readOrNull, available = os.availableParallelism()) {
    let limit = null;
    const v2 = read('/sys/fs/cgroup/cpu.max');
    if (v2 !== null) {
        limit = parseCpuMax(v2);
    } else {
        const q = read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
        const p = read('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
        if (q !== null && p !== null) { limit = parseCfs(q, p); }
    }
    return { available, limit, effective: Math.max(1, limit ? Math.min(available, limit) : available) };
}

// ---------------------------------------------------------------------------
// Maths & formatting
// ---------------------------------------------------------------------------

/** Average number of attempts for an n-character ending. */
const meanAttempts = (n) => ALPHABET_SIZE ** n;
/** Attempts after which the search has finished with probability q (geometric distribution). */
const quantileAttempts = (n, q) => -Math.log(1 - q) * ALPHABET_SIZE ** n;
/** Probability that a search for an n-character ending is done after k attempts. */
const probabilityDone = (n, k) => 1 - Math.exp(k * Math.log1p(-(ALPHABET_SIZE ** -n)));

function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) { return '∞'; }
    if (seconds < 1) { return '<1 s'; }
    if (seconds < 90) { return `${Math.round(seconds)} s`; }
    if (seconds < 90 * 60) { return `${(seconds / 60).toFixed(1)} min`; }
    if (seconds < 48 * 3600) { return `${(seconds / 3600).toFixed(1)} h`; }
    if (seconds < 365 * 86400) { return `${(seconds / 86400).toFixed(1)} days`; }
    return `${(seconds / (365 * 86400)).toFixed(1)} years`;
}

function formatCount(n) {
    if (n < 1e4) { return String(Math.round(n)); }
    if (n < 1e6) { return `${(n / 1e3).toFixed(1)}K`; }
    if (n < 1e9) { return `${(n / 1e6).toFixed(1)}M`; }
    if (n < 1e12) { return `${(n / 1e9).toFixed(2)}B`; }
    return n.toExponential(2);
}

const formatMoney = (usd) => (usd < 0.01 ? '<$0.01' : `$${usd.toFixed(usd < 100 ? 2 : 0)}`);

/** Table rows: expected time (median / mean / 90%) and cost for each ending length. */
function estimateRows(rate, price, lengths) {
    return lengths.map((n) => {
        const median = quantileAttempts(n, 0.5) / rate;
        const mean = meanAttempts(n) / rate;
        const p90 = quantileAttempts(n, 0.9) / rate;
        const row = {
            length: n,
            attempts: formatCount(meanAttempts(n)),
            median: formatDuration(median),
            mean: formatDuration(mean),
            p90: formatDuration(p90),
        };
        if (price) { row.cost = formatMoney((mean / 3600) * price); }
        return row;
    });
}

function printTable(rows, log) {
    const cols = Object.keys(rows[0]);
    const head = { length: 'chars', attempts: 'attempts (avg)', median: '50% done', mean: 'average', p90: '90% done', cost: 'avg cost' };
    const width = cols.map((c) => Math.max(head[c].length, ...rows.map((r) => String(r[c]).length)));
    const line = (r) => cols.map((c, i) => String(r[c]).padEnd(width[i])).join('  ');
    log(line(head));
    log(width.map((w) => '-'.repeat(w)).join('  '));
    rows.forEach((r) => log(line(r)));
}

// ---------------------------------------------------------------------------
// Attempt counting: ton-wallet-finder has no progress callback, but with `showProcess`
// it logs one line per attempt. Swallow those lines and count them instead.
// ---------------------------------------------------------------------------

function installAttemptCounter(target = console) {
    const original = target.log;
    const counter = {
        attempts: 0,
        restore() { target.log = original; },
    };
    target.log = (...args) => {
        if (args[0] === ATTEMPT_LOG_PREFIX) { counter.attempts++; return; }
        original.apply(target, args);
    };
    return counter;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function resolveOutDir(out) {
    if (out) { return path.resolve(out); }
    // /workspace is RunPod's persistent volume; fall back to /results, then cwd.
    for (const dir of ['/workspace', '/results']) {
        try {
            fs.accessSync(dir, fs.constants.W_OK);
            return dir;
        } catch { /* try next */ }
    }
    return process.cwd();
}

function resolveWorkers(workers) {
    return workers === 'auto' ? detectCpus().effective : workers;
}

async function cmdFind(opts, ctx) {
    const { log, env } = ctx;
    const ending = opts.args[0];
    const n = ending.length;
    const workers = resolveWorkers(opts.workers);
    const outDir = resolveOutDir(opts.out);
    const password = env.TWF_PASSWORD || '';

    fs.mkdirSync(outDir, { recursive: true });

    log(`[twf] ton-wallet-finder ${LIB_VERSION} | wallet ${opts.wallet} | ending "${ending}" (case-sensitive)`);
    log(`[twf] workers: ${workers} | wallets to find: ${opts.count} | results dir: ${outDir}`);
    log(`[twf] ~${formatCount(meanAttempts(n))} attempts per wallet on average`);
    if (password) {
        log('[twf] results will be ENCRYPTED with TWF_PASSWORD (scrypt + AES-256-GCM)');
    } else {
        log('[twf] WARNING: TWF_PASSWORD is not set — results are saved as PLAIN TEXT');
    }
    if (n >= 5) { log(`[twf] note: ${n} characters can take days to months; run "bench" first to estimate cost`); }

    const counter = installAttemptCounter(console);
    const controller = new AbortController();
    const stop = (signal) => controller.abort(`Received ${signal}`);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    const started = Date.now();
    let wallet = 0;
    let walletStarted = started;
    let walletStartAttempts = 0;

    const timer = setInterval(() => {
        const elapsed = (Date.now() - started) / 1000;
        const rate = counter.attempts / elapsed;
        const k = counter.attempts - walletStartAttempts;
        const p = probabilityDone(n, k);
        const median = quantileAttempts(n, 0.5);
        const left = rate > 0 && k < median ? formatDuration((median - k) / rate) : 'any moment now';
        log(`[progress] wallet ${wallet + 1}/${opts.count} | ${formatCount(counter.attempts)} attempts | `
            + `${rate.toFixed(1)}/s | elapsed ${formatDuration(elapsed)} | chance found by now ${(p * 100).toFixed(1)}% | `
            + `50% mark in ${left}`);
    }, opts.progress * 1000);
    timer.unref();

    const found = [];
    try {
        for (; wallet < opts.count; wallet++) {
            walletStarted = Date.now();
            walletStartAttempts = counter.attempts;
            const finder = new TonWalletFinder(ending, { walletVersion: opts.wallet, showProcess: true, workers });
            const result = await finder.findWalletWithEnding({ signal: controller.signal });
            const took = (Date.now() - walletStarted) / 1000;
            const attempts = counter.attempts - walletStartAttempts;

            const cwd = process.cwd();
            let file;
            try {
                process.chdir(outDir); // saveResultsToFile writes into the cwd
                file = await saveResultsToFile(result.publicKey, result.privateKey, result.words,
                    result.walletAddress, password ? { password } : {});
            } finally {
                process.chdir(cwd);
            }

            log('');
            log(`=============== FOUND ${wallet + 1}/${opts.count} ===============`);
            log(`Wallet:   ${result.walletAddress}  (${opts.wallet})`);
            log(`Attempts: ${formatCount(attempts)} in ${formatDuration(took)}`);
            if (!file) { throw new Error(`Could not save the result to ${outDir}`); }
            log(`Saved to: ${file}${password ? ' (encrypted)' : ' (PLAIN TEXT)'}`);
            if (password) {
                log('Encrypted copy (safe to keep; decrypt with "twf decrypt <file>" + TWF_PASSWORD):');
                log('-----BEGIN TWF ENCRYPTED RESULT-----');
                // one line, so it can be copied from the pod's log viewer in one go
                log(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))));
                log('-----END TWF ENCRYPTED RESULT-----');
            }
            if (opts.printSecret) {
                log('Words:       ' + result.words.join(' '));
                log('Public key:  ' + result.publicKey);
                log('Private key: ' + result.privateKey);
            } else if (!password) {
                log(`Read it from the pod's terminal: cat ${file}`);
            }
            log('==================================================');
            log('');
            found.push({ ...result, file });
        }
    } finally {
        clearInterval(timer);
        counter.restore();
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
    }
    const total = (Date.now() - started) / 1000;
    log(`[twf] done: ${found.length} wallet(s), ${formatCount(counter.attempts)} attempts in ${formatDuration(total)} `
        + `(${(counter.attempts / total).toFixed(1)}/s)`);
    log('[twf] Move the funds/keys into your own wallet app and DELETE THIS POD AND ITS VOLUME when done.');
    return found;
}

async function cmdBench(opts, ctx) {
    const { log } = ctx;
    const workers = resolveWorkers(opts.workers);
    const warmup = Math.min(5, opts.seconds / 5);
    log(`[twf] benchmark: ${workers} worker(s), ${opts.seconds} s (+${warmup} s warm-up), wallet ${opts.wallet}`);

    const counter = installAttemptCounter(console);
    const controller = new AbortController();
    let base = 0;
    let t0 = Date.now();
    const warm = setTimeout(() => { base = counter.attempts; t0 = Date.now(); }, warmup * 1000);
    const end = setTimeout(() => controller.abort('benchmark finished'), (warmup + opts.seconds) * 1000);
    let rate;
    try {
        // A 46-character ending is never found (64^-46); the search runs until aborted.
        const finder = new TonWalletFinder('A'.repeat(MAX_ENDING), { walletVersion: opts.wallet, showProcess: true, workers });
        await finder.findWalletWithEnding({ signal: controller.signal });
    } catch (err) {
        if (err.name !== 'AbortError') { throw err; }
    } finally {
        rate = (counter.attempts - base) / ((Date.now() - t0) / 1000);
        clearTimeout(warm);
        clearTimeout(end);
        counter.restore();
    }

    const cpus = detectCpus();
    log(`[twf] speed: ${rate.toFixed(1)} addresses/s (${(rate / workers).toFixed(1)}/s per worker)`);
    log(`[twf] CPU: ${os.cpus()[0]?.model ?? 'unknown'} | visible ${cpus.available}, cgroup limit ${cpus.limit ?? 'none'}`);
    log('');
    printTable(estimateRows(rate, opts.price, [1, 2, 3, 4, 5, 6]), log);
    if (!opts.price) { log('\nAdd --price <USD per hour> (or TWF_PRICE_PER_HOUR) to see the cost column.'); }
    return rate;
}

function cmdEstimate(opts, ctx) {
    const { log } = ctx;
    if (!opts.rate) { throw new UsageError('estimate needs --rate <addresses per second> (run "bench" to measure it)'); }
    const arg = opts.args[0];
    const n = /^\d+$/.test(arg) ? Number(arg) : arg.length;
    if (n < 1 || n > MAX_ENDING) { throw new UsageError(`Length must be between 1 and ${MAX_ENDING}`); }
    log(`[twf] at ${opts.rate}/s${opts.price ? `, $${opts.price}/h` : ''}:`);
    printTable(estimateRows(opts.rate, opts.price, [n]), log);
}

async function cmdDecrypt(opts, ctx) {
    const { log, env } = ctx;
    if (!env.TWF_PASSWORD) { throw new UsageError('Set the TWF_PASSWORD environment variable to decrypt'); }
    let file = opts.args[0];
    if (!fs.existsSync(file)) {
        const alt = path.join(resolveOutDir(opts.out), file);
        if (fs.existsSync(alt)) { file = alt; }
    }
    const r = await decryptResults(fs.readFileSync(file), env.TWF_PASSWORD);
    log(`Wallet:      ${r.walletAddress}`);
    log(`Words:       ${r.words.join(' ')}`);
    log(`Public key:  ${r.publicKey}`);
    log(`Private key: ${r.privateKey}`);
    return r;
}

function cmdList(opts, ctx) {
    const dir = resolveOutDir(opts.out);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('ton_wallet_results')).sort();
    ctx.log(files.length ? files.map((f) => path.join(dir, f)).join('\n') : `No results in ${dir}`);
    return files;
}

function cmdCores(opts, ctx) {
    const c = detectCpus();
    ctx.log(`visible CPUs: ${c.available}\ncgroup limit: ${c.limit ?? 'none'}\nworkers "auto" uses: ${c.effective}`);
    ctx.log(`CPU model: ${os.cpus()[0]?.model ?? 'unknown'}`);
    return c;
}

const HELP = `twf — TON vanity wallet finder (ton-wallet-finder ${LIB_VERSION}, image ${IMAGE_VERSION})

Usage:
  twf <ending> [options]          same as "find <ending>"
  twf find <ending> [options]     search for a wallet whose address ends with <ending>
  twf bench [options]             measure speed and print time/cost per ending length
  twf estimate <ending|length> --rate <n> [--price <usd/h>]
  twf decrypt <file>              print an encrypted result (needs TWF_PASSWORD)
  twf list                        list result files
  twf cores                       show detected CPU count
  twf version | help

Options:
  -w, --wallet v3r2|v4r2|v5r1     wallet contract version (default v4r2)     [TWF_WALLET]
  -j, --workers <n>|auto          worker threads (default auto = CPU limit)  [TWF_WORKERS]
  -n, --count <n>                 how many wallets to find (default 1)       [TWF_COUNT]
  -o, --out <dir>                 results dir (default /workspace, /results) [TWF_OUT]
  -t, --seconds <n>               bench duration (default 30)                [TWF_BENCH_SECONDS]
  -r, --rate <n>                  addresses/s for "estimate"                 [TWF_RATE]
  -p, --price <usd>               pod price per hour for cost columns        [TWF_PRICE_PER_HOUR]
      --progress <sec>            progress line interval (default 60)        [TWF_PROGRESS]
      --print-secret              also print the mnemonic to the log         [TWF_PRINT_SECRET=1]

Environment:
  TWF_PASSWORD    encrypt results with this password (strongly recommended)
  TWF_ENDING      ending to search for when no command is given
  TWF_KEEP_ALIVE  1/0: keep the container running after the command (default: on RunPod)

The ending is case-sensitive; allowed characters: A-Z a-z 0-9 - _
`;

async function main(argv = process.argv.slice(2), ctx = {}) {
    const log = ctx.log ?? ((...a) => console.log(...a));
    const env = ctx.env ?? process.env;
    const err = ctx.error ?? ((...a) => console.error(...a));
    let opts;
    try {
        opts = parseCli(argv, env);
    } catch (e) {
        if (e instanceof UsageError) { err(`Error: ${e.message}\nRun "twf help" for usage.`); return 2; }
        throw e;
    }
    const c = { log, env };
    try {
        switch (opts.command) {
            case 'find':     await cmdFind(opts, c); break;
            case 'bench':    await cmdBench(opts, c); break;
            case 'estimate': cmdEstimate(opts, c); break;
            case 'decrypt':  await cmdDecrypt(opts, c); break;
            case 'list':     cmdList(opts, c); break;
            case 'cores':    cmdCores(opts, c); break;
            case 'version':  log(`twf-docker ${IMAGE_VERSION}, ton-wallet-finder ${LIB_VERSION}, node ${process.version}`); break;
            default:         log(HELP);
        }
        return 0;
    } catch (e) {
        if (e instanceof UsageError) { err(`Error: ${e.message}`); return 2; }
        if (e.name === 'AbortError') { err(`[twf] stopped: ${e.message}`); return 130; }
        err(`Error: ${e.message}${e.cause ? ` (${e.cause.message ?? e.cause})` : ''}`);
        return 1;
    }
}

module.exports = {
    main,
    parseCli,
    parseCpuMax,
    parseCfs,
    detectCpus,
    meanAttempts,
    quantileAttempts,
    probabilityDone,
    formatDuration,
    formatCount,
    estimateRows,
    installAttemptCounter,
    UsageError,
};

if (require.main === module) {
    main().then((code) => { process.exitCode = code; });
}
