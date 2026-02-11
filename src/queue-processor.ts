#!/usr/bin/env node
/**
 * Queue Processor - Sends messages to a persistent Claude Code tmux session
 * via send-keys. Captures responses by tailing Claude's JSONL conversation logs.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = path.resolve(__dirname, '..');
const QUEUE_INCOMING = path.join(SCRIPT_DIR, '.tinyclaw/queue/incoming');
const QUEUE_OUTGOING = path.join(SCRIPT_DIR, '.tinyclaw/queue/outgoing');
const QUEUE_PROCESSING = path.join(SCRIPT_DIR, '.tinyclaw/queue/processing');
const LOG_FILE = path.join(SCRIPT_DIR, '.tinyclaw/logs/queue.log');

// Claude Code writes structured JSONL conversation logs here
const JSONL_DIR = path.join(
    process.env.HOME || '',
    '.claude/projects/-Users-shakeshack-Documents-sandbox-imperial-clawflict'
);

// Directory where Claude writes plan files
const PLANS_DIR = path.join(process.env.HOME || '', '.claude/plans');

// tmux target for the persistent Claude session
const TMUX_TARGET = '0:imperial-clawflict.0';

// How long to wait for a response (ms)
const RESPONSE_TIMEOUT = 10800000; // 3 hours

// How long the JSONL file must be quiet before we consider the response complete (ms)
const QUIET_THRESHOLD = 5000;

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

interface QuestionOption {
    label: string;
    description: string;
}

interface PendingInteraction {
    type: 'question' | 'plan';
    options?: QuestionOption[];
    question?: string;
}

// Module-level state: tracks if Claude is waiting for interactive input
let pendingInteraction: PendingInteraction | null = null;

// Logger
function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

// Send a message to the Claude tmux pane
function sendToClaudePane(message: string, sender: string): void {
    const prefixed = `[Discord message from ${sender}]: ${message}`;
    const escaped = prefixed.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t "${TMUX_TARGET}" -l '${escaped}'`);
    execSync(`tmux send-keys -t "${TMUX_TARGET}" Enter`);
}

// Snapshot all .jsonl files and their line counts
function snapshotJsonlFiles(): Map<string, number> {
    const snapshot = new Map<string, number>();
    try {
        if (!fs.existsSync(JSONL_DIR)) return snapshot;
        for (const f of fs.readdirSync(JSONL_DIR)) {
            if (!f.endsWith('.jsonl')) continue;
            const filePath = path.join(JSONL_DIR, f);
            snapshot.set(filePath, getFileLineCount(filePath));
        }
    } catch {}
    return snapshot;
}

// After sending a message, detect which .jsonl file grew (that's the active session)
function detectActiveJsonlFile(before: Map<string, number>): { file: string; startLine: number } | null {
    try {
        if (!fs.existsSync(JSONL_DIR)) return null;
        for (const f of fs.readdirSync(JSONL_DIR)) {
            if (!f.endsWith('.jsonl')) continue;
            const filePath = path.join(JSONL_DIR, f);
            const currentLines = getFileLineCount(filePath);
            const prevLines = before.get(filePath) ?? 0;
            if (currentLines > prevLines) {
                return { file: filePath, startLine: prevLines };
            }
        }
        // Also check for entirely new files
        for (const f of fs.readdirSync(JSONL_DIR)) {
            if (!f.endsWith('.jsonl')) continue;
            const filePath = path.join(JSONL_DIR, f);
            if (!before.has(filePath)) {
                return { file: filePath, startLine: 0 };
            }
        }
    } catch {}
    return null;
}

// Count lines in a file
function getFileLineCount(filePath: string): number {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (!content) return 0;
        return content.split('\n').filter(line => line.trim().length > 0).length;
    } catch {
        return 0;
    }
}

// Read new lines from a JSONL file after a given line number
function readNewLines(filePath: string, afterLine: number): string[] {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const allLines = content.split('\n').filter(line => line.trim().length > 0);
        return allLines.slice(afterLine);
    } catch {
        return [];
    }
}

// Check if new lines contain a turn_duration system entry (definitive end of turn)
function hasTurnEnded(newLines: string[]): boolean {
    for (let i = newLines.length - 1; i >= 0; i--) {
        try {
            const entry = JSON.parse(newLines[i]);
            if (entry.type === 'system' && entry.subtype === 'turn_duration') {
                return true;
            }
        } catch {}
    }
    return false;
}

// Extract the last assistant text from JSONL lines
function extractLastAssistantText(newLines: string[]): string | null {
    if (newLines.length === 0) return null;

    // Walk backwards to find the last assistant message with text content
    for (let i = newLines.length - 1; i >= 0; i--) {
        try {
            const entry = JSON.parse(newLines[i]);
            if (entry.type === 'assistant' && entry.message?.content) {
                const textBlocks = entry.message.content
                    .filter((block: any) => block.type === 'text' && block.text?.trim())
                    .map((block: any) => block.text.trim());

                if (textBlocks.length > 0) {
                    return textBlocks.join('\n\n');
                }
            }
        } catch {
            // Skip malformed lines
        }
    }

    return null;
}

// Check if the JSONL shows Claude waiting for interactive input (AskUserQuestion / ExitPlanMode)
function checkForPendingInteraction(newLines: string[]): PendingInteraction | null {
    // Walk backwards to find the last assistant entry
    for (let i = newLines.length - 1; i >= 0; i--) {
        try {
            const entry = JSON.parse(newLines[i]);
            if (entry.type !== 'assistant') continue;

            for (const block of entry.message?.content || []) {
                if (block.type !== 'tool_use') continue;

                if (block.name === 'AskUserQuestion') {
                    const q = block.input?.questions?.[0];
                    if (q) {
                        return {
                            type: 'question',
                            question: q.question,
                            options: q.options || [],
                        };
                    }
                }

                if (block.name === 'ExitPlanMode') {
                    return { type: 'plan' };
                }
            }

            // If last assistant entry isn't a tool_use for these, no pending interaction
            break;
        } catch {}
    }
    return null;
}

// Check that a tool_result hasn't already been received for the pending interaction
function hasToolResult(newLines: string[], afterIndex: number): boolean {
    for (let i = afterIndex + 1; i < newLines.length; i++) {
        try {
            const entry = JSON.parse(newLines[i]);
            if (entry.type === 'user') {
                const content = entry.message?.content;
                if (Array.isArray(content)) {
                    for (const b of content) {
                        if (b.type === 'tool_result') return true;
                    }
                }
            }
        } catch {}
    }
    return false;
}

// Find the line index of the last pending interaction tool_use
function findInteractionIndex(newLines: string[]): number {
    for (let i = newLines.length - 1; i >= 0; i--) {
        try {
            const entry = JSON.parse(newLines[i]);
            if (entry.type === 'assistant') {
                for (const block of entry.message?.content || []) {
                    if (block.type === 'tool_use' &&
                        (block.name === 'AskUserQuestion' || block.name === 'ExitPlanMode')) {
                        return i;
                    }
                }
            }
        } catch {}
    }
    return -1;
}

// Format a pending interaction as a Discord message
function formatInteractionForDiscord(interaction: PendingInteraction): string {
    if (interaction.type === 'question' && interaction.options) {
        let msg = `**Claude is asking a question:**\n\n${interaction.question}\n\n`;
        interaction.options.forEach((opt, i) => {
            msg += `**${i + 1}.** ${opt.label} — ${opt.description}\n`;
        });
        msg += `\nReply with a number (1-${interaction.options.length}) to select, or type a custom answer.`;
        return msg;
    }

    if (interaction.type === 'plan') {
        return `**Claude has a plan ready for approval.**\n\nReply **yes** to approve or provide feedback to reject.`;
    }

    return '(Claude is waiting for input — check tmux session)';
}

// Send keystrokes to the TUI to respond to an interactive prompt
function sendInteractionKeystroke(interaction: PendingInteraction, userReply: string): void {
    const reply = userReply.trim();

    if (interaction.type === 'question' && interaction.options) {
        const optionNum = parseInt(reply, 10);
        if (optionNum >= 1 && optionNum <= interaction.options.length) {
            // Navigate to option: Down arrow (N-1) times, then Enter
            for (let i = 1; i < optionNum; i++) {
                execSync(`tmux send-keys -t "${TMUX_TARGET}" Down`);
            }
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Enter`);
            log('INFO', `Selected option ${optionNum}: ${interaction.options[optionNum - 1].label}`);
        } else {
            // "Other" — navigate past all options to Other, then type text
            for (let i = 0; i <= interaction.options.length; i++) {
                execSync(`tmux send-keys -t "${TMUX_TARGET}" Down`);
            }
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Enter`);
            // Type the custom text
            const escaped = reply.replace(/'/g, "'\\''");
            execSync(`tmux send-keys -t "${TMUX_TARGET}" -l '${escaped}'`);
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Enter`);
            log('INFO', `Selected Other with text: ${reply.substring(0, 50)}`);
        }
    } else if (interaction.type === 'plan') {
        const isApproval = /^(y|yes|approve|accept|ok|go|lgtm)$/i.test(reply);
        if (isApproval) {
            // Accept the plan — press Enter (default accept)
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Enter`);
            log('INFO', 'Approved plan');
        } else {
            // Reject — press Escape, then type feedback as next message
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Escape`);
            const escaped = reply.replace(/'/g, "'\\''");
            execSync(`tmux send-keys -t "${TMUX_TARGET}" -l '${escaped}'`);
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Enter`);
            log('INFO', `Rejected plan with feedback: ${reply.substring(0, 50)}`);
        }
    }
}

// Snapshot plan files at a point in time
function snapshotPlans(): Map<string, number> {
    const snapshot = new Map<string, number>();
    try {
        if (fs.existsSync(PLANS_DIR)) {
            for (const file of fs.readdirSync(PLANS_DIR)) {
                if (file.endsWith('.md')) {
                    const filePath = path.join(PLANS_DIR, file);
                    const stat = fs.statSync(filePath);
                    snapshot.set(filePath, stat.mtimeMs);
                }
            }
        }
    } catch {}
    return snapshot;
}

// Check for new or modified plan files since a snapshot
function checkForNewPlan(before: Map<string, number>): string | null {
    try {
        if (!fs.existsSync(PLANS_DIR)) return null;
        for (const file of fs.readdirSync(PLANS_DIR)) {
            if (!file.endsWith('.md')) continue;
            const filePath = path.join(PLANS_DIR, file);
            const stat = fs.statSync(filePath);
            const prevMtime = before.get(filePath);
            if (prevMtime === undefined || stat.mtimeMs > prevMtime) {
                const content = fs.readFileSync(filePath, 'utf8').trim();
                if (content.length > 0) {
                    return `**Claude has a plan ready for approval:**\n\n${content}`;
                }
            }
        }
    } catch {}
    return null;
}

// Wait for Claude's response by watching all JSONL files for growth
async function waitForResponse(beforeSnapshot: Map<string, number>): Promise<string> {
    const plansBefore = snapshotPlans();

    return new Promise((resolve) => {
        const startTime = Date.now();
        let activeFile: string | null = null;
        let startLine = 0;
        let lastLineCount = 0;
        let lastGrowthAt = 0;
        let planLastChecked = Date.now();

        const check = setInterval(() => {
            // Phase 1: Detect which file is receiving our message
            if (!activeFile) {
                const detected = detectActiveJsonlFile(beforeSnapshot);
                if (detected) {
                    activeFile = detected.file;
                    startLine = detected.startLine;
                    lastLineCount = getFileLineCount(activeFile);
                    lastGrowthAt = Date.now();
                    log('INFO', `Detected active JSONL: ${path.basename(activeFile)} (from line ${startLine})`);
                }
            }

            // Phase 2: Once we know the file, check for turn completion
            if (activeFile) {
                const currentLineCount = getFileLineCount(activeFile);

                if (currentLineCount > lastLineCount) {
                    lastLineCount = currentLineCount;
                    lastGrowthAt = Date.now();
                }

                const newLines = readNewLines(activeFile, startLine);

                // Primary signal: system entry with subtype "turn_duration" = turn is done
                if (hasTurnEnded(newLines)) {
                    clearInterval(check);
                    const text = extractLastAssistantText(newLines);
                    if (text) {
                        log('INFO', 'Turn ended (turn_duration detected)');
                        resolve(text);
                    } else {
                        resolve('(Claude completed work but produced no text response — check tmux session)');
                    }
                    return;
                }

                // Fallback: quiet period — check for pending interaction or plain text
                if (lastGrowthAt > 0 && newLines.length > 0) {
                    const quietFor = Date.now() - lastGrowthAt;
                    if (quietFor >= QUIET_THRESHOLD) {
                        // Check if Claude is waiting for interactive input
                        const interactionIdx = findInteractionIndex(newLines);
                        if (interactionIdx >= 0 && !hasToolResult(newLines, interactionIdx)) {
                            const interaction = checkForPendingInteraction(newLines);
                            if (interaction) {
                                clearInterval(check);
                                pendingInteraction = interaction;
                                log('INFO', `Detected pending ${interaction.type} interaction`);
                                resolve(formatInteractionForDiscord(interaction));
                                return;
                            }
                        }

                        // Otherwise return last text if available
                        const text = extractLastAssistantText(newLines);
                        if (text) {
                            clearInterval(check);
                            log('INFO', `Responding after ${QUIET_THRESHOLD}ms quiet (no turn_duration yet)`);
                            resolve(text);
                            return;
                        }
                    }
                }
            }

            // Check for new plan files every 5 seconds
            if (Date.now() - planLastChecked >= 5000) {
                planLastChecked = Date.now();
                const plan = checkForNewPlan(plansBefore);
                if (plan) {
                    clearInterval(check);
                    resolve(plan);
                    return;
                }
            }

            // Timeout
            if (Date.now() - startTime > RESPONSE_TIMEOUT) {
                clearInterval(check);
                if (activeFile) {
                    const newLines = readNewLines(activeFile, startLine);
                    const text = extractLastAssistantText(newLines);
                    resolve(text || '(Response timed out — check tmux session)');
                } else {
                    resolve('(Response timed out — no JSONL activity detected)');
                }
            }
        }, 1000);
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

        // Snapshot all JSONL files before sending the message
        const beforeSnapshot = snapshotJsonlFiles();
        log('INFO', `Snapshotted ${beforeSnapshot.size} JSONL file(s)`);

        // Check if this is a response to a pending interaction (question/plan)
        if (pendingInteraction) {
            const interaction = pendingInteraction;
            pendingInteraction = null;
            log('INFO', `Responding to pending ${interaction.type} interaction: ${message.substring(0, 50)}`);
            sendInteractionKeystroke(interaction, message);
        } else {
            // Normal message — send with prefix
            sendToClaudePane(message, sender);
        }
        log('INFO', `Sent to Claude pane (${TMUX_TARGET}), watching for JSONL growth...`);

        // Wait for response — detects which file grows after our send-keys
        const response = await waitForResponse(beforeSnapshot);

        // Limit response length for Discord
        let trimmedResponse = response;
        if (trimmedResponse.length > 4000) {
            trimmedResponse = trimmedResponse.substring(0, 3900) + '\n\n[Response truncated...]';
        }

        // Write response to outgoing queue
        const responseData: ResponseData = {
            channel,
            sender,
            message: trimmedResponse,
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
log('INFO', 'Queue processor started (JSONL log tailing mode)');
log('INFO', `Tmux target: ${TMUX_TARGET}`);
log('INFO', `JSONL dir: ${JSONL_DIR}`);
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
