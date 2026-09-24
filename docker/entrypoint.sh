#!/bin/bash
#
# 9Router · SAIRI edition entrypoint
#
# 1. shows the system / runtime banner
# 2. starts 9Router:
#      - arguments given          -> run them          (docker run image bash)
#      - Pterodactyl (STARTUP)    -> ask "start 9Router? (y/n)", then run the startup command
#      - interactive terminal     -> 9Router CLI menu
#      - detached / no terminal   -> headless web server

NINEROUTER_HOME="${NINEROUTER_HOME:-/opt/9router}"

cd /home/container 2>/dev/null || cd "${HOME:-/}" || true
export HOME="${HOME:-/home/container}"
export INTERNAL_IP
INTERNAL_IP=$(ip route get 1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)

# --- ANSI colors ------------------------------------------------------------
RESET='\033[0m'
BOLD='\033[1m'
CYAN='\033[1;36m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
MAGENTA='\033[1;35m'
PINK='\033[38;5;212m'
GRAY='\033[0;90m'

LINE="${GRAY}$(printf '%.0s─' $(seq 1 60))${RESET}"

# --- helpers ----------------------------------------------------------------
make_bar() {
    local percent=$1 width=25
    [ "$percent" -gt 100 ] && percent=100
    [ "$percent" -lt 0 ] && percent=0
    local filled=$(( percent * width / 100 ))
    local empty=$(( width - filled ))
    local bar=""
    [ "$filled" -gt 0 ] && bar+=$(printf '%0.s█' $(seq 1 "$filled"))
    [ "$empty" -gt 0 ] && bar+=$(printf '%0.s░' $(seq 1 "$empty"))
    echo -n "$bar"
}

# Memory as the container sees it (cgroup limit), falling back to the host numbers.
read_memory() {
    local host_total used_b total_b
    host_total=$(free -m 2>/dev/null | awk '/Mem:/ {print $2}')
    MEM_TOTAL=${host_total:-0}
    MEM_USED=$(free -m 2>/dev/null | awk '/Mem:/ {print $3}')
    MEM_USED=${MEM_USED:-0}

    if [ -r /sys/fs/cgroup/memory.max ]; then                          # cgroup v2
        total_b=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)
        used_b=$(cat /sys/fs/cgroup/memory.current 2>/dev/null)
    elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then      # cgroup v1
        total_b=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)
        used_b=$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null)
    fi

    if [[ "$total_b" =~ ^[0-9]+$ ]] && [[ "$used_b" =~ ^[0-9]+$ ]]; then
        local total_mb=$(( total_b / 1024 / 1024 ))
        if [ "$total_mb" -gt 0 ] && { [ "$MEM_TOTAL" -eq 0 ] || [ "$total_mb" -lt "$MEM_TOTAL" ]; }; then
            MEM_TOTAL=$total_mb
            MEM_USED=$(( used_b / 1024 / 1024 ))
        fi
    fi
    [ "$MEM_TOTAL" -le 0 ] && MEM_TOTAL=1
    MEM_PERCENT=$(( MEM_USED * 100 / MEM_TOTAL ))
}

print_logo() {
    echo -e "${GREEN}${BOLD}"
    cat <<'ART'
 ___  ___   ___   _   _  _____  ___  ___ 
/ _ \| _ \ / _ \ | | | ||_   _|| __|| _ \
\_, /|   /| (_) || |_| |  | |  | _| |   /
 /_/ |_|_\ \___/  \___/   |_|  |___||_|_\
ART
    echo -e "${RESET}"
}

# y/n prompt. Enter or no answer within the timeout counts as "y", so unattended
# restarts (auto-start after a crash or reboot) never hang on the question.
ask_start() {
    local timeout="${START_PROMPT_TIMEOUT:-30}" ans
    while true; do
        echo -e "${PINK}${BOLD}Jalankan 9Router sekarang? (y/n)${RESET} ${GRAY}[Enter/otomatis = y dalam ${timeout} detik]${RESET}"
        if ! read -r -t "$timeout" ans; then
            return 0
        fi
        case "${ans,,}" in
            ""|y|yes|ya) return 0 ;;
            n|no|tidak)  return 1 ;;
            *) echo -e "${YELLOW}Ketik y (yes) atau n (no).${RESET}" ;;
        esac
    done
}

# "n": leave 9Router off and hand over a shell
open_shell() {
    echo -e "${PINK}${BOLD}Silahkan masukan perintah.${RESET}"
    echo -e "${GRAY}Jalankan 9Router kapan saja: 9router --port ${SERVER_PORT:-20128} --simple-menu${RESET}"
    export PS1='\[\e[1;32m\]container\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '
    exec /bin/bash --norc -i
}

show_banner() {
    read_memory
    local disk_used disk_total disk_percent
    disk_used=$(df -h /home/container 2>/dev/null | awk 'NR==2 {print $3}')
    disk_total=$(df -h /home/container 2>/dev/null | awk 'NR==2 {print $2}')
    disk_percent=$(df -h /home/container 2>/dev/null | awk 'NR==2 {print $5}' | tr -d '%')
    disk_percent=${disk_percent:-0}

    local os_name cpu_name cpu_cores location
    os_name=$(grep -oP '(?<=^PRETTY_NAME=).+' /etc/os-release 2>/dev/null | tr -d '"')
    cpu_name=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ //')
    cpu_cores=$(grep -c ^processor /proc/cpuinfo 2>/dev/null)
    location=$(curl -s --max-time 2 ipinfo.io/country 2>/dev/null | tr -d '\n')
    [[ "$location" =~ ^[A-Z]{2}$ ]] || location="Unknown"

    local node_v router_v port pass_state
    node_v=$(node -v 2>/dev/null || echo "Not Installed")
    router_v=$(node -p "require('${NINEROUTER_HOME}/package.json').version" 2>/dev/null || echo "Not Installed")
    port="${SERVER_PORT:-${PORT:-20128}}"
    if [ -n "${INITIAL_PASSWORD}" ]; then
        pass_state="${GREEN}set${RESET}"
    else
        pass_state="${YELLOW}not set${RESET} ${GRAY}(remote login is blocked with the default password)${RESET}"
    fi

    [ -t 1 ] && clear
    print_logo
    echo -e "$LINE"
    echo -e "${CYAN}Location${RESET}   : ${location}"
    if [[ "${SHOW_IP,,}" == "true" || "${SHOW_IP}" == "1" ]]; then
        local public_ip
        public_ip=$(curl -s --max-time 2 ipinfo.io/ip 2>/dev/null | tr -d '\n')
        [[ "$public_ip" =~ ^[0-9a-fA-F:.]+$ ]] || public_ip="Unknown"
        echo -e "${CYAN}IP Address${RESET} : ${public_ip}"
    fi
    echo -e "${CYAN}OS${RESET}         : ${os_name:-Unknown}"
    echo -e "${CYAN}CPU${RESET}        : ${cpu_name:-Unknown} (${cpu_cores:-?} Cores)"
    echo -e "${CYAN}Uptime${RESET}     : $(uptime -p 2>/dev/null | sed 's/up //')"
    echo -e "${CYAN}RAM${RESET}  ${YELLOW}${MEM_PERCENT}%${RESET}  ${GREEN}$(make_bar "$MEM_PERCENT")${RESET}  ${GRAY}${MEM_USED}/${MEM_TOTAL}MB${RESET}"
    echo -e "${CYAN}Disk${RESET} ${YELLOW}${disk_percent}%${RESET}  ${YELLOW}$(make_bar "$disk_percent")${RESET}  ${GRAY}${disk_used:-?}/${disk_total:-?}${RESET}"
    echo -e "$LINE"
    echo -e "${BLUE}9Router${RESET}      : v${router_v}"
    echo -e "${BLUE}Node.js${RESET}      : ${node_v}"
    echo -e "${BLUE}Port${RESET}         : ${port}"
    echo -e "${BLUE}Data dir${RESET}     : ${DATA_DIR:-$HOME/.9router}"
    echo -e "${BLUE}Password${RESET}     : ${pass_state}"
    echo -e "$LINE"
}

# --- go ---------------------------------------------------------------------
show_banner

# 1) explicit command (docker run image bash)
if [ "$#" -gt 0 ]; then
    exec "$@"
fi

# 2) Pterodactyl / Pelican: the panel passes the startup command in $STARTUP
if [ -n "${STARTUP}" ]; then
    # turn {{VAR}} into ${VAR} and expand (same approach as the official yolks)
    PARSED=$(echo "${STARTUP}" | sed -e 's/{{/${/g' -e 's/}}/}/g' | eval echo "$(cat -)")
    if ask_start; then
        echo -e "${GREEN}${BOLD}Memulai 9Router...${RESET}"
        # shellcheck disable=SC2086
        exec env ${PARSED}
    fi
    open_shell
fi

# 3) plain docker with a terminal (docker run -it): interactive CLI
if [ -t 0 ]; then
    echo -e "${PINK}${BOLD}Menjalankan 9Router (CLI)...${RESET}"
    exec node "${NINEROUTER_HOME}/cli.js" --port "${SERVER_PORT:-${PORT:-20128}}" --no-browser
fi

# 4) plain docker, detached (docker run -d): headless web server
echo -e "${PINK}${BOLD}Menjalankan 9Router (headless server)...${RESET}"
exec /usr/local/bin/9router-server
