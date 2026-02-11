#!/usr/bin/env node
/**
 * Queue Processor - Sends messages to a persistent Claude Code tmux session
 * via send-keys. Captures responses by tailing Claude's JSONL conversation logs.
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

// Load settings
interface Settings {
    working_dir?: string;
    tmux_target?: string;
    [key: string]: unknown;
}

function loadSettings(): Settings {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
        return {};
    }
}

// Derive JSONL_DIR from working_dir: Claude escapes the absolute path,
// replacing both / and _ with -
function workingDirToJsonlDir(workingDir: string): string {
    const escaped = workingDir.replace(/[/_]/g, '-');
    return path.join(process.env.HOME || '', '.claude/projects', escaped);
}

const settings = loadSettings();

// Claude Code writes structured JSONL conversation logs here
const JSONL_DIR = workingDirToJsonlDir(
    settings.working_dir || '/Users/shakeshack/Documents/sandbox/imperial_clawflict'
);

// Directory where Claude writes plan files (global, not per-project)
const PLANS_DIR = path.join(process.env.HOME || '', '.claude/plans');

// tmux target for the persistent Claude session
const TMUX_TARGET = settings.tmux_target || '0:imperial-clawflict.0';

// How long to wait for a response (ms)
const RESPONSE_TIMEOUT = 10800000; // 3 hours

// How long the JSONL file must be quiet before checking for pending interactions (ms)
// Only used for AskUserQuestion/ExitPlanMode detection — NOT for regular responses
const INTERACTION_QUIET_THRESHOLD = 5000;

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

interface QuestionEntry {
    question: string;
    options: QuestionOption[];
    header?: string;
}

interface PendingInteraction {
    type: 'question' | 'plan';
    questions?: QuestionEntry[];  // all questions (may be 1-4)
    contextText?: string;         // assistant text before the question/plan
    planContent?: string;
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
    // Strip newlines from Discord messages (they'd be interpreted as Enter in the TUI)
    const cleanMessage = message.replace(/\n/g, ' ');
    const prefixed = `[Discord message from ${sender}]: ${cleanMessage}`;
    const escaped = prefixed.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t "${TMUX_TARGET}" -l '${escaped}'`);
    // Small delay to let the TUI process the text before submitting
    execSync('sleep 0.2');
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

// Check if the last entry is a system entry like stop_hook_summary
// (indicates turn may have ended, but turn_duration wasn't written)
function lastEntryIsSystemBoundary(newLines: string[]): boolean {
    for (let i = newLines.length - 1; i >= 0; i--) {
        const line = newLines[i].trim();
        if (!line) continue;
        try {
            const entry = JSON.parse(line);
            return entry.type === 'system' && entry.subtype === 'stop_hook_summary';
        } catch {}
        break;
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

// Extract the session slug from JSONL lines (used to find the correct plan file)
function extractSlug(newLines: string[]): string | null {
    for (const line of newLines) {
        try {
            const entry = JSON.parse(line);
            if (entry.slug) return entry.slug;
        } catch {}
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
                    const rawQuestions = block.input?.questions || [];
                    if (rawQuestions.length > 0) {
                        // Extract any text blocks from the same assistant entry (context)
                        const textBlocks = (entry.message?.content || [])
                            .filter((b: any) => b.type === 'text' && b.text?.trim())
                            .map((b: any) => b.text.trim());
                        const questions: QuestionEntry[] = rawQuestions.map((q: any) => ({
                            question: q.question,
                            options: q.options || [],
                            header: q.header,
                        }));
                        return {
                            type: 'question',
                            questions,
                            contextText: textBlocks.length > 0 ? textBlocks.join('\n\n') : undefined,
                        };
                    }
                }

                if (block.name === 'ExitPlanMode') {
                    // Read plan file matching this session's slug
                    let planContent = '';
                    const slug = extractSlug(newLines);
                    if (slug) {
                        const planFile = path.join(PLANS_DIR, `${slug}.md`);
                        try {
                            if (fs.existsSync(planFile)) {
                                planContent = fs.readFileSync(planFile, 'utf8').trim();
                            }
                        } catch {}
                    }
                    return { type: 'plan', planContent: planContent || undefined };
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
    if (interaction.type === 'question' && interaction.questions && interaction.questions.length > 0) {
        let msg = '';
        // Include Claude's text context if present (the text before the question)
        if (interaction.contextText) {
            msg += interaction.contextText + '\n\n---\n';
        }

        const multi = interaction.questions.length > 1;

        interaction.questions.forEach((q, qi) => {
            if (multi) {
                msg += `**Q${qi + 1}:** `;
            } else {
                msg += '**Claude is asking:** ';
            }
            msg += `${q.question}\n\n`;
            q.options.forEach((opt, oi) => {
                msg += `**${oi + 1}.** ${opt.label} — ${opt.description}\n`;
            });
            msg += '\n';
        });

        msg += '---\n';
        if (multi) {
            msg += `Reply with answers separated by commas (e.g. **1, 2, 3**)\n`;
            msg += `Each position = one question. Use a number to pick an option or text for a custom answer.`;
        } else {
            const optCount = interaction.questions[0].options.length;
            msg += `**1-${optCount}** → select that option\n**anything else** → sent as custom answer`;
        }
        return msg;
    }

    if (interaction.type === 'plan') {
        let msg = `**Claude has a plan ready for approval:**\n\n`;
        if (interaction.planContent) {
            msg += interaction.planContent;
        } else {
            msg += '(Could not read plan file)';
        }
        msg += `\n\n---\n**yes** / **approve** → execute this plan\n**anything else** → sent as feedback, Claude will revise the plan`;
        return msg;
    }

    return '(Claude is waiting for input — check tmux session)';
}

// Send keystrokes to the TUI to respond to an interactive prompt
function sendInteractionKeystroke(interaction: PendingInteraction, userReply: string): void {
    const reply = userReply.trim();

    if (interaction.type === 'question' && interaction.questions && interaction.questions.length > 0) {
        // Split reply by commas for multi-question support: "1, 3, 2" or just "1"
        const answers = reply.split(',').map(a => a.trim());

        for (let qi = 0; qi < interaction.questions.length; qi++) {
            const q = interaction.questions[qi];
            const answer = answers[qi] || answers[0]; // fall back to first answer if not enough
            const optionNum = parseInt(answer, 10);

            // Navigate between questions: Tab moves to next question group
            if (qi > 0) {
                execSync(`tmux send-keys -t "${TMUX_TARGET}" Tab`);
                execSync('sleep 0.1');
            }

            if (optionNum >= 1 && optionNum <= q.options.length) {
                // Navigate to option: Down arrow (N-1) times from default position
                for (let i = 1; i < optionNum; i++) {
                    execSync(`tmux send-keys -t "${TMUX_TARGET}" Down`);
                }
                log('INFO', `Q${qi + 1}: selected option ${optionNum}: ${q.options[optionNum - 1].label}`);
            } else {
                // "Other" — navigate past all options, select it, type text
                for (let i = 0; i < q.options.length; i++) {
                    execSync(`tmux send-keys -t "${TMUX_TARGET}" Down`);
                }
                // Select "Other" and type custom text
                execSync(`tmux send-keys -t "${TMUX_TARGET}" Enter`);
                execSync('sleep 0.3');
                const escaped = answer.replace(/'/g, "'\\''");
                execSync(`tmux send-keys -t "${TMUX_TARGET}" -l '${escaped}'`);
                log('INFO', `Q${qi + 1}: selected Other with text: ${answer.substring(0, 50)}`);
            }
        }

        // Submit the form
        execSync(`tmux send-keys -t "${TMUX_TARGET}" Enter`);
        log('INFO', `Submitted ${interaction.questions.length} question(s)`);
    } else if (interaction.type === 'plan') {
        // ExitPlanMode TUI options:
        //   1. Yes, clear context and bypass permissions (default)
        //   2. Yes, and bypass permissions
        //   3. Yes, manually approve edits
        //   4. Type feedback
        const isApproval = /^(y|yes|approve|accept|ok|go|lgtm)$/i.test(reply);
        if (isApproval) {
            // Select option 2 — "Yes, and bypass permissions"
            // (option 1 clears context, creating a new JSONL session file)
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Down`);
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Enter`);
            log('INFO', 'Approved plan (option 2: bypass permissions)');
        } else {
            // Select option 4 — "Type feedback" for plan iteration
            // Down x3 from default position, then Enter to select
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Down`);
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Down`);
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Down`);
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Enter`);
            execSync('sleep 0.3');
            // Type the feedback text and submit
            const escaped = reply.replace(/'/g, "'\\''");
            execSync(`tmux send-keys -t "${TMUX_TARGET}" -l '${escaped}'`);
            execSync('sleep 0.2');
            execSync(`tmux send-keys -t "${TMUX_TARGET}" Enter`);
            log('INFO', `Plan feedback (option 4): ${reply.substring(0, 50)}`);
        }
    }
}

// (Plan detection is handled via ExitPlanMode in JSONL — no file polling needed)

// Wait for Claude's response by watching all JSONL files for growth
async function waitForResponse(beforeSnapshot: Map<string, number>): Promise<string> {
    return new Promise((resolve) => {
        const startTime = Date.now();
        let activeFile: string | null = null;
        let startLine = 0;
        let lastLineCount = 0;
        let lastGrowthAt = 0;

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
                    log('DEBUG', `JSONL grew: ${lastLineCount} → ${currentLineCount} lines`);
                    lastLineCount = currentLineCount;
                    lastGrowthAt = Date.now();
                }

                // Check for file rotation (e.g., "clear context" creates a new session)
                // If a newer JSONL file exists that wasn't in our snapshot, switch to it
                try {
                    for (const f of fs.readdirSync(JSONL_DIR)) {
                        if (!f.endsWith('.jsonl')) continue;
                        const filePath = path.join(JSONL_DIR, f);
                        if (filePath === activeFile) continue;
                        if (!beforeSnapshot.has(filePath)) {
                            // Brand new file created after we started — this is the new session
                            const newCount = getFileLineCount(filePath);
                            if (newCount > 0) {
                                log('INFO', `JSONL file rotated: ${path.basename(activeFile)} → ${path.basename(filePath)}`);
                                activeFile = filePath;
                                startLine = 0;
                                lastLineCount = newCount;
                                lastGrowthAt = Date.now();
                            }
                        }
                    }
                } catch {}

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

                // Quiet-period checks: interaction detection + stop_hook_summary fallback
                if (lastGrowthAt > 0 && newLines.length > 0) {
                    const quietFor = Date.now() - lastGrowthAt;
                    if (quietFor >= INTERACTION_QUIET_THRESHOLD) {
                        // Check for pending interaction (AskUserQuestion/ExitPlanMode)
                        const interactionIdx = findInteractionIndex(newLines);
                        if (interactionIdx >= 0) {
                            const hasResult = hasToolResult(newLines, interactionIdx);
                            log('DEBUG', `Interaction found at idx ${interactionIdx}, hasToolResult=${hasResult}, quiet=${quietFor}ms`);
                            if (!hasResult) {
                                const interaction = checkForPendingInteraction(newLines);
                                if (interaction) {
                                    clearInterval(check);
                                    pendingInteraction = interaction;
                                    log('INFO', `Detected pending ${interaction.type} interaction after ${quietFor}ms quiet`);
                                    resolve(formatInteractionForDiscord(interaction));
                                    return;
                                } else {
                                    log('DEBUG', 'findInteractionIndex matched but checkForPendingInteraction returned null');
                                }
                            }
                        }

                        // Fallback: stop_hook_summary as last entry + quiet = turn likely ended
                        // (turn_duration isn't always written)
                        if (lastEntryIsSystemBoundary(newLines)) {
                            const text = extractLastAssistantText(newLines);
                            if (text) {
                                clearInterval(check);
                                log('INFO', `Turn ended (stop_hook_summary + ${quietFor}ms quiet)`);
                                resolve(text);
                                return;
                            }
                        }
                    }
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

        // Write response to outgoing queue (Discord client handles splitting into 2000-char messages)
        const responseData: ResponseData = {
            channel,
            sender,
            message: response,
            originalMessage: message,
            timestamp: Date.now(),
            messageId
        };

        const responseFile = channel === 'heartbeat'
            ? path.join(QUEUE_OUTGOING, `${messageId}.json`)
            : path.join(QUEUE_OUTGOING, `${channel}_${messageId}_${Date.now()}.json`);

        fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));

        log('INFO', `✓ Response ready [${channel}] ${sender} (${response.length} chars)`);

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
