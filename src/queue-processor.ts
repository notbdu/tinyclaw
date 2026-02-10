#!/usr/bin/env node
/**
 * Queue Processor - Sends messages to a persistent Claude Code tmux session
 * via send-keys, and watches the output log for responses.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = path.resolve(__dirname, '..');
const SETTINGS_FILE = path.join(SCRIPT_DIR, '.tinyclaw/settings.json');
const QUEUE_INCOMING = path.join(SCRIPT_DIR, '.tinyclaw/queue/incoming');
const QUEUE_OUTGOING = path.join(SCRIPT_DIR, '.tinyclaw/queue/outgoing');
const QUEUE_PROCESSING = path.join(SCRIPT_DIR, '.tinyclaw/queue/processing');
const LOG_FILE = path.join(SCRIPT_DIR, '.tinyclaw/logs/queue.log');

// Claude output log written by tmux pipe-pane
const CLAUDE_OUTPUT_LOG = path.join(SCRIPT_DIR, 'claude-output.log');

// tmux target for the persistent Claude session
const TMUX_TARGET = '0:imperial-clawflict.0';

// How long to wait for Claude to respond before giving up (ms)
const RESPONSE_TIMEOUT = 600000; // 10 minutes

// How long Claude must be quiet before we consider the response complete (ms)
const QUIET_THRESHOLD = 5000; // 5 seconds of no new output

// Ensure directories exist
[QUEUE_INCOMING, QUEUE_OUTGOING, QUEUE_PROCESSING, path.dirname(LOG_FILE)].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

interface MessageData {
    channel: string;
    sender: string;
    senderId?: string;
    message: string;
    timestamp: number;
    messageId: string;
}

interface ResponseData {
    channel: string;
    sender: string;
    message: string;
    originalMessage: string;
    timestamp: number;
    messageId: string;
}

// Strip ANSI escape sequences and Claude Code TUI artifacts from terminal output
function cleanTerminalOutput(raw: string): string {
    let text = raw;

    // Strip OSC sequences (window titles etc): \x1b] ... \x07 or \x1b\\
    text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

    // Strip CSI sequences: \x1b[ ... <letter>
    text = text.replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '');

    // Strip DEC private mode: \x1b[? ... h/l
    text = text.replace(/\x1b\[\?[0-9;]*[hl]/g, '');

    // Strip remaining escape sequences
    text = text.replace(/\x1b[^[\x1b]?/g, '');

    // Strip any leftover raw control chars except newline/tab
    text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

    // Split into lines for filtering
    const lines = text.split('\n');
    const filtered = lines.filter(line => {
        const trimmed = line.trim();

        // Skip empty lines (will rejoin later)
        if (!trimmed) return false;

        // Skip spinner lines (just spinner chars and whitespace)
        if (/^[✻✳✶✢·✽⠐⠑⠒⠓⠔⠕⠖⠗⠘⠙⠚⠛⠜⠝⠞⠟⠠⠡⠢⠣⠤⠥⠦⠧⠨⠩⠪⠫⠬⠭⠮⠯⠰⠱⠲⠳⠴⠵⠶⠷⠸⠹⠺⠻⠼⠽⠾⠿]\s*(Whirring|Thinking|Working).*$/i.test(trimmed)) return false;

        // Skip bare spinner chars
        if (/^[✻✳✶✢·✽⠐⠑⠒⠓⠔⠕⠖⠗⠘⠙⠚⠛⠜⠝⠞⠟⠠⠡⠢⠣⠤⠥⠦⠧⠨⠩⠪⠫⠬⠭⠮⠯⠰⠱⠲⠳⠴⠵⠶⠷⠸⠹⠺⠻⠼⠽⠾⠿\s]*$/.test(trimmed)) return false;

        // Skip prompt lines
        if (/^❯\s*$/.test(trimmed)) return false;

        // Skip status bar lines
        if (/⏵⏵\s*bypass\s*permissions/i.test(trimmed)) return false;

        // Skip separator lines (────)
        if (/^[─━─\-]{5,}$/.test(trimmed)) return false;

        // Skip Claude Code UI chrome (esc to interrupt, shift+tab, ctrl+t)
        if (/esc\s+to\s+interrupt|shift\+tab\s+to\s+cycle|ctrl\+t\s+to\s+hide/i.test(trimmed)) return false;

        return true;
    });

    // Rejoin and collapse excessive blank lines
    return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Logger
function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

// Send a message to the Claude tmux pane
function sendToClaudePane(message: string): void {
    // Escape single quotes for the shell
    const escaped = message.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t "${TMUX_TARGET}" -l '${escaped}'`);
    execSync(`tmux send-keys -t "${TMUX_TARGET}" Enter`);
}

// Get the current size of the Claude output log
function getOutputLogSize(): number {
    try {
        const stat = fs.statSync(CLAUDE_OUTPUT_LOG);
        return stat.size;
    } catch {
        return 0;
    }
}

// Read new content from the output log since a given byte offset
function readNewOutput(fromByte: number): string {
    try {
        const fd = fs.openSync(CLAUDE_OUTPUT_LOG, 'r');
        const stat = fs.fstatSync(fd);
        const bytesToRead = stat.size - fromByte;
        if (bytesToRead <= 0) {
            fs.closeSync(fd);
            return '';
        }
        const buffer = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buffer, 0, bytesToRead, fromByte);
        fs.closeSync(fd);
        return buffer.toString('utf8');
    } catch {
        return '';
    }
}

// Wait for Claude to finish responding by watching the output log
async function waitForResponse(startByte: number): Promise<string> {
    return new Promise((resolve) => {
        const startTime = Date.now();
        let lastSize = startByte;
        let lastChangeTime = Date.now();
        let settled = false;

        const check = setInterval(() => {
            const currentSize = getOutputLogSize();

            if (currentSize > lastSize) {
                // New output arrived
                lastSize = currentSize;
                lastChangeTime = Date.now();
            } else if (currentSize === lastSize && !settled) {
                // No new output — check if quiet long enough
                const quietFor = Date.now() - lastChangeTime;
                if (quietFor >= QUIET_THRESHOLD && lastSize > startByte) {
                    // Claude has been quiet for QUIET_THRESHOLD and we have some output
                    settled = true;
                    clearInterval(check);
                    const newContent = readNewOutput(startByte);
                    resolve(newContent.trim());
                }
            }

            // Timeout
            if (Date.now() - startTime > RESPONSE_TIMEOUT) {
                clearInterval(check);
                const newContent = readNewOutput(startByte);
                resolve(newContent.trim() || '(Response timed out)');
            }
        }, 500);
    });
}

// Process a single message
async function processMessage(messageFile: string): Promise<void> {
    const processingFile = path.join(QUEUE_PROCESSING, path.basename(messageFile));

    try {
        // Move to processing to mark as in-progress
        fs.renameSync(messageFile, processingFile);

        // Read message
        const messageData: MessageData = JSON.parse(fs.readFileSync(processingFile, 'utf8'));
        const { channel, sender, message, messageId } = messageData;

        log('INFO', `Processing [${channel}] from ${sender}: ${message.substring(0, 50)}...`);

        // Record current output log size before sending
        const startByte = getOutputLogSize();

        // Send message to Claude via tmux send-keys
        sendToClaudePane(message);
        log('INFO', `Sent to Claude pane (${TMUX_TARGET})`);

        // Wait for Claude to respond
        const rawResponse = await waitForResponse(startByte);

        // Clean terminal escape codes and TUI artifacts
        const response = cleanTerminalOutput(rawResponse);

        // Limit response length for Discord
        let trimmedResponse = response;
        if (trimmedResponse.length > 4000) {
            trimmedResponse = trimmedResponse.substring(0, 3900) + '\n\n[Response truncated...]';
        }

        // Write response to outgoing queue
        const responseData: ResponseData = {
            channel,
            sender,
            message: trimmedResponse || '(No response captured — check tmux session)',
            originalMessage: message,
            timestamp: Date.now(),
            messageId
        };

        const responseFile = channel === 'heartbeat'
            ? path.join(QUEUE_OUTGOING, `${messageId}.json`)
            : path.join(QUEUE_OUTGOING, `${channel}_${messageId}_${Date.now()}.json`);

        fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));

        log('INFO', `✓ Response ready [${channel}] ${sender} (${trimmedResponse.length} chars)`);

        // Clean up processing file
        fs.unlinkSync(processingFile);

    } catch (error) {
        log('ERROR', `Processing error: ${(error as Error).message}`);

        // Move back to incoming for retry
        if (fs.existsSync(processingFile)) {
            try {
                fs.renameSync(processingFile, messageFile);
            } catch (e) {
                log('ERROR', `Failed to move file back: ${(e as Error).message}`);
            }
        }
    }
}

interface QueueFile {
    name: string;
    path: string;
    time: number;
}

// Main processing loop
async function processQueue(): Promise<void> {
    try {
        // Get all files from incoming queue, sorted by timestamp
        const files: QueueFile[] = fs.readdirSync(QUEUE_INCOMING)
            .filter(f => f.endsWith('.json'))
            .map(f => ({
                name: f,
                path: path.join(QUEUE_INCOMING, f),
                time: fs.statSync(path.join(QUEUE_INCOMING, f)).mtimeMs
            }))
            .sort((a, b) => a.time - b.time);

        if (files.length > 0) {
            log('DEBUG', `Found ${files.length} message(s) in queue`);

            // Process one at a time
            for (const file of files) {
                await processMessage(file.path);
            }
        }
    } catch (error) {
        log('ERROR', `Queue processing error: ${(error as Error).message}`);
    }
}

// Main loop
log('INFO', 'Queue processor started (tmux send-keys mode)');
log('INFO', `Tmux target: ${TMUX_TARGET}`);
log('INFO', `Claude output log: ${CLAUDE_OUTPUT_LOG}`);
log('INFO', `Watching: ${QUEUE_INCOMING}`);

// Process queue every 1 second
setInterval(processQueue, 1000);

// Graceful shutdown
process.on('SIGINT', () => {
    log('INFO', 'Shutting down queue processor...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down queue processor...');
    process.exit(0);
});
