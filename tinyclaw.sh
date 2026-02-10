#!/bin/bash
# TinyClaw Simple - Main daemon using tmux + claude -c -p + WhatsApp + Discord

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMUX_SESSION="tinyclaw"
LOG_DIR="$SCRIPT_DIR/.tinyclaw/logs"
SETTINGS_FILE="$SCRIPT_DIR/.tinyclaw/settings.json"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/daemon.log"
}

# Load settings from JSON
load_settings() {
    if [ ! -f "$SETTINGS_FILE" ]; then
        return 1
    fi

    CHANNEL=$(grep -o '"channel"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
    MODEL=$(grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
    DISCORD_TOKEN=$(grep -o '"discord_bot_token"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)

    return 0
}

# Check if session exists
session_exists() {
    tmux has-session -t "$TMUX_SESSION" 2>/dev/null
}

# Start daemon
start_daemon() {
    if session_exists; then
        echo -e "${YELLOW}Session already running${NC}"
        return 1
    fi

    log "Starting TinyClaw daemon..."

    # Check if Node.js dependencies are installed
    if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
        echo -e "${YELLOW}Installing Node.js dependencies...${NC}"
        cd "$SCRIPT_DIR"
        PUPPETEER_SKIP_DOWNLOAD=true npm install
    fi

    # Build TypeScript if needed
    if [ ! -d "$SCRIPT_DIR/dist" ] || [ "$SCRIPT_DIR/src/whatsapp-client.ts" -nt "$SCRIPT_DIR/dist/whatsapp-client.js" ] || [ "$SCRIPT_DIR/src/queue-processor.ts" -nt "$SCRIPT_DIR/dist/queue-processor.js" ] || [ "$SCRIPT_DIR/src/discord-client.ts" -nt "$SCRIPT_DIR/dist/discord-client.js" ]; then
        echo -e "${YELLOW}Building TypeScript...${NC}"
        cd "$SCRIPT_DIR"
        npm run build
    fi

    # Load settings or run setup wizard
    if ! load_settings; then
        echo -e "${YELLOW}No configuration found. Running setup wizard...${NC}"
        echo ""
        "$SCRIPT_DIR/setup-wizard.sh"

        # Reload settings after setup
        if ! load_settings; then
            echo -e "${RED}Setup failed or was cancelled${NC}"
            return 1
        fi
    fi

    # Set channel flags
    HAS_DISCORD=false
    HAS_WHATSAPP=false

    case "$CHANNEL" in
        discord) HAS_DISCORD=true ;;
        whatsapp) HAS_WHATSAPP=true ;;
        both) HAS_DISCORD=true; HAS_WHATSAPP=true ;;
        *)
            echo -e "${RED}Invalid channel config: $CHANNEL${NC}"
            echo "Run './tinyclaw.sh setup' to reconfigure"
            return 1
            ;;
    esac

    # Validate Discord token if Discord is enabled
    if [ "$HAS_DISCORD" = true ] && [ -z "$DISCORD_TOKEN" ]; then
        echo -e "${RED}Discord is configured but bot token is missing${NC}"
        echo "Run './tinyclaw.sh setup' to reconfigure"
        return 1
    fi

    # Write Discord token to .env for the Node.js client
    if [ "$HAS_DISCORD" = true ]; then
        if [ -f "$SCRIPT_DIR/.env" ]; then
            # Update existing .env
            if grep -q "^DISCORD_BOT_TOKEN=" "$SCRIPT_DIR/.env"; then
                sed -i.bak "s/^DISCORD_BOT_TOKEN=.*/DISCORD_BOT_TOKEN=$DISCORD_TOKEN/" "$SCRIPT_DIR/.env"
            else
                echo "DISCORD_BOT_TOKEN=$DISCORD_TOKEN" >> "$SCRIPT_DIR/.env"
            fi
        else
            # Create new .env
            echo "DISCORD_BOT_TOKEN=$DISCORD_TOKEN" > "$SCRIPT_DIR/.env"
        fi
    fi

    # Report channels
    echo -e "${BLUE}Channels:${NC}"
    [ "$HAS_DISCORD" = true ] && echo -e "  ${GREEN}✓${NC} Discord"
    [ "$HAS_WHATSAPP" = true ] && echo -e "  ${GREEN}✓${NC} WhatsApp"
    echo ""

    # Build log tail command based on available channels
    LOG_TAIL_CMD="tail -f .tinyclaw/logs/queue.log"
    if [ "$HAS_DISCORD" = true ]; then
        LOG_TAIL_CMD="$LOG_TAIL_CMD .tinyclaw/logs/discord.log"
    fi
    if [ "$HAS_WHATSAPP" = true ]; then
        LOG_TAIL_CMD="$LOG_TAIL_CMD .tinyclaw/logs/whatsapp.log"
    fi

    tmux new-session -d -s "$TMUX_SESSION" -n "tinyclaw" -c "$SCRIPT_DIR"

    if [ "$HAS_WHATSAPP" = true ] && [ "$HAS_DISCORD" = true ]; then
        # Both channels: 5 panes
        # ┌──────────┬──────────┬──────────┐
        # │ WhatsApp │ Discord  │  Queue   │
        # ├──────────┴──────────┼──────────┤
        # │     Heartbeat       │   Logs   │
        # └─────────────────────┴──────────┘
        tmux split-window -v -t "$TMUX_SESSION" -c "$SCRIPT_DIR"
        tmux split-window -h -t "$TMUX_SESSION:0.0" -c "$SCRIPT_DIR"
        tmux split-window -h -t "$TMUX_SESSION:0.1" -c "$SCRIPT_DIR"
        tmux split-window -h -t "$TMUX_SESSION:0.3" -c "$SCRIPT_DIR"

        tmux send-keys -t "$TMUX_SESSION:0.0" "cd '$SCRIPT_DIR' && node dist/whatsapp-client.js" C-m
        tmux send-keys -t "$TMUX_SESSION:0.1" "cd '$SCRIPT_DIR' && node dist/discord-client.js" C-m
        tmux send-keys -t "$TMUX_SESSION:0.2" "cd '$SCRIPT_DIR' && node dist/queue-processor.js" C-m
        tmux send-keys -t "$TMUX_SESSION:0.3" "cd '$SCRIPT_DIR' && ./heartbeat-cron.sh" C-m
        tmux send-keys -t "$TMUX_SESSION:0.4" "cd '$SCRIPT_DIR' && $LOG_TAIL_CMD" C-m

        tmux select-pane -t "$TMUX_SESSION:0.0" -T "WhatsApp"
        tmux select-pane -t "$TMUX_SESSION:0.1" -T "Discord"
        tmux select-pane -t "$TMUX_SESSION:0.2" -T "Queue"
        tmux select-pane -t "$TMUX_SESSION:0.3" -T "Heartbeat"
        tmux select-pane -t "$TMUX_SESSION:0.4" -T "Logs"

        PANE_COUNT=5
        WHATSAPP_PANE=0

    elif [ "$HAS_DISCORD" = true ]; then
        # Discord only: 4 panes (2x2 grid)
        # ┌──────────┬──────────┐
        # │ Discord  │  Queue   │
        # ├──────────┼──────────┤
        # │Heartbeat │   Logs   │
        # └──────────┴──────────┘
        tmux split-window -v -t "$TMUX_SESSION" -c "$SCRIPT_DIR"
        tmux split-window -h -t "$TMUX_SESSION:0.0" -c "$SCRIPT_DIR"
        tmux split-window -h -t "$TMUX_SESSION:0.2" -c "$SCRIPT_DIR"

        tmux send-keys -t "$TMUX_SESSION:0.0" "cd '$SCRIPT_DIR' && node dist/discord-client.js" C-m
        tmux send-keys -t "$TMUX_SESSION:0.1" "cd '$SCRIPT_DIR' && node dist/queue-processor.js" C-m
        tmux send-keys -t "$TMUX_SESSION:0.2" "cd '$SCRIPT_DIR' && ./heartbeat-cron.sh" C-m
        tmux send-keys -t "$TMUX_SESSION:0.3" "cd '$SCRIPT_DIR' && $LOG_TAIL_CMD" C-m

        tmux select-pane -t "$TMUX_SESSION:0.0" -T "Discord"
        tmux select-pane -t "$TMUX_SESSION:0.1" -T "Queue"
        tmux select-pane -t "$TMUX_SESSION:0.2" -T "Heartbeat"
        tmux select-pane -t "$TMUX_SESSION:0.3" -T "Logs"

        PANE_COUNT=4
        WHATSAPP_PANE=-1

    else
        # WhatsApp only: 4 panes (2x2 grid)
        # ┌──────────┬──────────┐
        # │ WhatsApp │  Queue   │
        # ├──────────┼──────────┤
        # │Heartbeat │   Logs   │
        # └──────────┴──────────┘
        tmux split-window -v -t "$TMUX_SESSION" -c "$SCRIPT_DIR"
        tmux split-window -h -t "$TMUX_SESSION:0.0" -c "$SCRIPT_DIR"
        tmux split-window -h -t "$TMUX_SESSION:0.2" -c "$SCRIPT_DIR"

        tmux send-keys -t "$TMUX_SESSION:0.0" "cd '$SCRIPT_DIR' && node dist/whatsapp-client.js" C-m
        tmux send-keys -t "$TMUX_SESSION:0.1" "cd '$SCRIPT_DIR' && node dist/queue-processor.js" C-m
        tmux send-keys -t "$TMUX_SESSION:0.2" "cd '$SCRIPT_DIR' && ./heartbeat-cron.sh" C-m
        tmux send-keys -t "$TMUX_SESSION:0.3" "cd '$SCRIPT_DIR' && $LOG_TAIL_CMD" C-m

        tmux select-pane -t "$TMUX_SESSION:0.0" -T "WhatsApp"
        tmux select-pane -t "$TMUX_SESSION:0.1" -T "Queue"
        tmux select-pane -t "$TMUX_SESSION:0.2" -T "Heartbeat"
        tmux select-pane -t "$TMUX_SESSION:0.3" -T "Logs"

        PANE_COUNT=4
        WHATSAPP_PANE=0
    fi

    echo ""
    echo -e "${GREEN}✓ TinyClaw started${NC}"
    echo ""

    # WhatsApp QR code flow — only when WhatsApp is being started
    if [ "$WHATSAPP_PANE" -ge 0 ]; then
        echo -e "${YELLOW}📱 Starting WhatsApp client...${NC}"
        echo ""

        QR_FILE="$SCRIPT_DIR/.tinyclaw/channels/whatsapp_qr.txt"
        READY_FILE="$SCRIPT_DIR/.tinyclaw/channels/whatsapp_ready"
        QR_DISPLAYED=false

        # Poll for ready flag (up to 60 seconds)
        for i in {1..60}; do
            sleep 1

            # Check if ready flag exists (WhatsApp is fully connected)
            if [ -f "$READY_FILE" ]; then
                echo ""
                echo -e "${GREEN}✅ WhatsApp connected and ready!${NC}"
                # Clean up QR code file if it exists
                rm -f "$QR_FILE"
                break
            fi

            # Check if QR code needs to be displayed
            if [ -f "$QR_FILE" ] && [ "$QR_DISPLAYED" = false ]; then
                # Wait a bit more to ensure file is fully written
                sleep 1

                clear
                echo ""
                echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
                echo -e "${GREEN}                    WhatsApp QR Code${NC}"
                echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
                echo ""
                # Display QR code from file (no tmux distortion!)
                cat "$QR_FILE"
                echo ""
                echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
                echo ""
                echo -e "${YELLOW}📱 Scan this QR code with WhatsApp:${NC}"
                echo ""
                echo "   1. Open WhatsApp on your phone"
                echo "   2. Go to Settings → Linked Devices"
                echo "   3. Tap 'Link a Device'"
                echo "   4. Scan the QR code above"
                echo ""
                echo -e "${BLUE}Waiting for connection...${NC}"
                QR_DISPLAYED=true
            fi

            # Show progress dots (only if QR was displayed or after 10 seconds)
            if [ "$QR_DISPLAYED" = true ] || [ $i -gt 10 ]; then
                echo -n "."
            fi
        done
        echo ""

        # Timeout warning
        if [ $i -eq 60 ] && [ ! -f "$READY_FILE" ]; then
            echo ""
            echo -e "${RED}⚠️  WhatsApp didn't connect within 60 seconds${NC}"
            echo ""
            echo -e "${YELLOW}Try restarting TinyClaw:${NC}"
            echo -e "  ${GREEN}./tinyclaw.sh restart${NC}"
            echo ""
            echo "Or check WhatsApp client status:"
            echo -e "  ${GREEN}tmux attach -t $TMUX_SESSION${NC}"
            echo ""
            echo "Or check logs:"
            echo -e "  ${GREEN}./tinyclaw.sh logs whatsapp${NC}"
            echo ""
        fi
    fi

    echo ""
    echo -e "${GREEN}Commands:${NC}"
    echo "  Status:  ./tinyclaw.sh status"
    echo "  Logs:    ./tinyclaw.sh logs [whatsapp|discord|queue]"
    echo "  Attach:  tmux attach -t $TMUX_SESSION"
    echo ""

    log "Daemon started with $PANE_COUNT panes (discord=$HAS_DISCORD, whatsapp=$HAS_WHATSAPP)"
}

# Stop daemon
stop_daemon() {
    log "Stopping TinyClaw..."

    if session_exists; then
        tmux kill-session -t "$TMUX_SESSION"
    fi

    # Kill any remaining processes
    pkill -f "dist/whatsapp-client.js" || true
    pkill -f "dist/discord-client.js" || true
    pkill -f "dist/queue-processor.js" || true
    pkill -f "heartbeat-cron.sh" || true

    echo -e "${GREEN}✓ TinyClaw stopped${NC}"
    log "Daemon stopped"
}

# Send message to Claude and get response
send_message() {
    local message="$1"
    local source="${2:-manual}"

    log "[$source] Sending: ${message:0:50}..."

    # Use working_dir from settings if set, otherwise fall back to SCRIPT_DIR
    local WORK_DIR
    WORK_DIR=$(grep -o '"working_dir"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" 2>/dev/null | cut -d'"' -f4)
    WORK_DIR="${WORK_DIR:-$SCRIPT_DIR}"

    # Use claude -c -p to continue and get final response
    cd "$WORK_DIR"
    RESPONSE=$(claude --dangerously-skip-permissions -c -p "$message" 2>&1)

    echo "$RESPONSE"

    log "[$source] Response length: ${#RESPONSE} chars"
}

# Status
status_daemon() {
    echo -e "${BLUE}TinyClaw Status${NC}"
    echo "==============="
    echo ""

    if session_exists; then
        echo -e "Tmux Session: ${GREEN}Running${NC}"
        echo "  Attach: tmux attach -t $TMUX_SESSION"
    else
        echo -e "Tmux Session: ${RED}Not Running${NC}"
        echo "  Start: ./tinyclaw.sh start"
    fi

    echo ""

    READY_FILE="$SCRIPT_DIR/.tinyclaw/channels/whatsapp_ready"

    if pgrep -f "dist/whatsapp-client.js" > /dev/null; then
        if [ -f "$READY_FILE" ]; then
            echo -e "WhatsApp Client: ${GREEN}Running & Ready${NC}"
        else
            echo -e "WhatsApp Client: ${YELLOW}Running (not ready yet)${NC}"
        fi
    else
        echo -e "WhatsApp Client: ${RED}Not Running${NC}"
    fi

    if pgrep -f "dist/discord-client.js" > /dev/null; then
        echo -e "Discord Client:  ${GREEN}Running${NC}"
    else
        echo -e "Discord Client:  ${RED}Not Running${NC}"
    fi

    if pgrep -f "dist/queue-processor.js" > /dev/null; then
        echo -e "Queue Processor: ${GREEN}Running${NC}"
    else
        echo -e "Queue Processor: ${RED}Not Running${NC}"
    fi

    if pgrep -f "heartbeat-cron.sh" > /dev/null; then
        echo -e "Heartbeat: ${GREEN}Running${NC}"
    else
        echo -e "Heartbeat: ${RED}Not Running${NC}"
    fi

    echo ""
    echo "Recent WhatsApp Activity:"
    echo "────────────────────────"
    tail -n 5 "$LOG_DIR/whatsapp.log" 2>/dev/null || echo "  No WhatsApp activity yet"

    echo ""
    echo "Recent Discord Activity:"
    echo "───────────────────────"
    tail -n 5 "$LOG_DIR/discord.log" 2>/dev/null || echo "  No Discord activity yet"

    echo ""
    echo "Recent Heartbeats:"
    echo "─────────────────"
    tail -n 3 "$LOG_DIR/heartbeat.log" 2>/dev/null || echo "  No heartbeat logs yet"

    echo ""
    echo "Logs:"
    echo "  WhatsApp: tail -f $LOG_DIR/whatsapp.log"
    echo "  Discord:  tail -f $LOG_DIR/discord.log"
    echo "  Heartbeat: tail -f $LOG_DIR/heartbeat.log"
    echo "  Daemon: tail -f $LOG_DIR/daemon.log"
}

# View logs
logs() {
    case "${1:-whatsapp}" in
        whatsapp|wa)
            tail -f "$LOG_DIR/whatsapp.log"
            ;;
        discord|dc)
            tail -f "$LOG_DIR/discord.log"
            ;;
        heartbeat|hb)
            tail -f "$LOG_DIR/heartbeat.log"
            ;;
        daemon|all)
            tail -f "$LOG_DIR/daemon.log"
            ;;
        *)
            echo "Usage: $0 logs [whatsapp|discord|heartbeat|daemon]"
            ;;
    esac
}

case "${1:-}" in
    start)
        start_daemon
        ;;
    stop)
        stop_daemon
        ;;
    restart)
        stop_daemon
        sleep 2
        start_daemon
        ;;
    status)
        status_daemon
        ;;
    send)
        if [ -z "$2" ]; then
            echo "Usage: $0 send <message>"
            exit 1
        fi
        send_message "$2" "cli"
        ;;
    logs)
        logs "$2"
        ;;
    reset)
        echo -e "${YELLOW}🔄 Resetting conversation...${NC}"
        touch "$SCRIPT_DIR/.tinyclaw/reset_flag"
        echo -e "${GREEN}✓ Reset flag set${NC}"
        echo ""
        echo "The next message will start a fresh conversation (without -c)."
        echo "After that, conversation will continue normally."
        ;;
    channels)
        if [ "$2" = "reset" ]; then
            case "$3" in
                whatsapp)
                    echo -e "${YELLOW}🔄 Resetting WhatsApp authentication...${NC}"
                    rm -rf "$SCRIPT_DIR/.tinyclaw/whatsapp-session"
                    rm -f "$SCRIPT_DIR/.tinyclaw/channels/whatsapp_ready"
                    rm -f "$SCRIPT_DIR/.tinyclaw/channels/whatsapp_qr.txt"
                    rm -rf "$SCRIPT_DIR/.wwebjs_cache"
                    echo -e "${GREEN}✓ WhatsApp session cleared${NC}"
                    echo ""
                    echo "Restart TinyClaw to re-authenticate:"
                    echo -e "  ${GREEN}./tinyclaw.sh restart${NC}"
                    ;;
                discord)
                    echo -e "${YELLOW}🔄 Resetting Discord authentication...${NC}"
                    echo ""
                    echo "To reset Discord, run the setup wizard to update your bot token:"
                    echo -e "  ${GREEN}./tinyclaw.sh setup${NC}"
                    echo ""
                    echo "Or manually edit .tinyclaw/settings.json to change discord_bot_token"
                    ;;
                *)
                    echo "Usage: $0 channels reset {whatsapp|discord}"
                    exit 1
                    ;;
            esac
        else
            echo "Usage: $0 channels reset {whatsapp|discord}"
            exit 1
        fi
        ;;
    model)
        if [ -z "$2" ]; then
            # Show current model
            if [ -f "$SETTINGS_FILE" ]; then
                CURRENT_MODEL=$(grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
                echo -e "${BLUE}Current model: ${GREEN}$CURRENT_MODEL${NC}"
            else
                echo -e "${RED}No settings file found${NC}"
                exit 1
            fi
        else
            case "$2" in
                sonnet|opus)
                    if [ ! -f "$SETTINGS_FILE" ]; then
                        echo -e "${RED}No settings file found. Run setup first.${NC}"
                        exit 1
                    fi

                    # Update model in settings.json
                    if [[ "$OSTYPE" == "darwin"* ]]; then
                        sed -i '' "s/\"model\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"model\": \"$2\"/" "$SETTINGS_FILE"
                    else
                        sed -i "s/\"model\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"model\": \"$2\"/" "$SETTINGS_FILE"
                    fi

                    echo -e "${GREEN}✓ Model switched to: $2${NC}"
                    echo ""
                    echo "Note: This affects the queue processor. Changes take effect on next message."
                    ;;
                *)
                    echo "Usage: $0 model {sonnet|opus}"
                    echo ""
                    echo "Examples:"
                    echo "  $0 model          # Show current model"
                    echo "  $0 model sonnet   # Switch to Sonnet"
                    echo "  $0 model opus     # Switch to Opus"
                    exit 1
                    ;;
            esac
        fi
        ;;
    attach)
        tmux attach -t "$TMUX_SESSION"
        ;;
    setup)
        "$SCRIPT_DIR/setup-wizard.sh"
        ;;
    *)
        echo -e "${BLUE}TinyClaw Simple - Claude Code + WhatsApp + Discord${NC}"
        echo ""
        echo "Usage: $0 {start|stop|restart|status|setup|send|logs|reset|channels|model|attach}"
        echo ""
        echo "Commands:"
        echo "  start                    Start TinyClaw"
        echo "  stop                     Stop all processes"
        echo "  restart                  Restart TinyClaw"
        echo "  status                   Show current status"
        echo "  setup                    Run setup wizard (change channels/model/heartbeat)"
        echo "  send <msg>               Send message to Claude manually"
        echo "  logs [type]              View logs (whatsapp|discord|heartbeat|daemon|queue)"
        echo "  reset                    Reset conversation (next message starts fresh)"
        echo "  channels reset <channel> Reset channel authentication (whatsapp|discord)"
        echo "  model [sonnet|opus]      Show or switch Claude model"
        echo "  attach                   Attach to tmux session"
        echo ""
        echo "Examples:"
        echo "  $0 start"
        echo "  $0 status"
        echo "  $0 model opus"
        echo "  $0 send 'What time is it?'"
        echo "  $0 channels reset whatsapp"
        echo "  $0 logs discord"
        echo ""
        exit 1
        ;;
esac
