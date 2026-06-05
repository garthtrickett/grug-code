#!/usr/bin/env bash

# ==========================================
# SETUP LOGGING
# ==========================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log() {
    echo -e "${CYAN}[$(date +'%H:%M:%S')]${NC} $1" >&2
}

warn() {
    echo -e "${YELLOW}[$(date +'%H:%M:%S')] WARNING:${NC} $1" >&2
}

error() {
    echo -e "${RED}[$(date +'%H:%M:%S')] ERROR:${NC} $1" >&2
}

# ==========================================
# HANDLE ARGUMENTS & LOAD CONFIG
# Usage: ./c.sh [profile]
# ==========================================

PROFILE="${1:-default}"
CONFIG_FILE="concat.config"

# Check if a specific profile is requested (and it's not the legacy 'mob' flag)
if [ "$PROFILE" != "default" ] && [ "$PROFILE" != "mob" ]; then
    if [ -f "concat.${PROFILE}.config" ]; then
        CONFIG_FILE="concat.${PROFILE}.config"
    else
        error "Configuration for profile '$PROFILE' not found."
        error "Expected file: concat.${PROFILE}.config"
        exit 1
    fi
fi

if [ -f "$CONFIG_FILE" ]; then
    log "Loading config: $CONFIG_FILE"
    # shellcheck source=concat.config
    source "$CONFIG_FILE"
else
    error "$CONFIG_FILE not found."
    exit 1
fi

# ==========================================
# SAFETY CHECKS
# ==========================================
if [ -z "$OUTPUT_FILE" ]; then
    OUTPUT_FILE="a.txt"
    warn "OUTPUT_FILE not defined in config. Defaulting to: $OUTPUT_FILE"
fi

if [ -f "$OUTPUT_FILE" ]; then
    log "Removing old output file: $OUTPUT_FILE"
    rm -f "$OUTPUT_FILE"
fi

TEMP_FILE="${OUTPUT_FILE}.tmp"
SCRIPT_NAME=$(basename "$0")

: >"$TEMP_FILE"
trap 'rm -f "$TEMP_FILE"' EXIT

rtree -I node_modules -I .git -I dist -I build -I coverage -I ios -I android --icons >>"$TEMP_FILE"
echo "Concatenating directory files..." >>"$TEMP_FILE"

# ==========================================
# LOGIC BUILDER
# ==========================================

log "Building file search arguments..."

# 1. Start building find arguments
# NOTE: We do NOT add (-type f) here yet.
find_args=(.)

# 2. Exclude script artifacts
find_args+=(-not -name "$CONFIG_FILE")
find_args+=(-not -name "$SCRIPT_NAME")
find_args+=(-not -name "$TEMP_FILE")
find_args+=(-not -name "$OUTPUT_FILE")

# 3. Add Excludes (-not -path)
for path in "${EXCLUDES[@]}"; do
    find_args+=(-not -path "$path")
done

# 4. Add Prunes (Smart Logic with Exceptions)
# Helper function to add prune args
add_prune_args() {
    local arr=("${@}")
    for item in "${arr[@]}"; do
        local has_exception=false
        local exception_args=()

        # Check if this prune path has any exceptions defined
        if [ ${#PRUNE_EXCEPTIONS[@]} -gt 0 ]; then
            for exc in "${PRUNE_EXCEPTIONS[@]}"; do
                # If an exception is inside this pruned directory
                if [[ "$exc" == "$item"/* ]]; then
                    has_exception=true
                    exception_args+=(-not -path "$exc" -not -path "$exc/*")
                fi
            done
        fi

        if [ "$has_exception" = true ]; then
            # Let find enter the parent dir, but prune all children EXCEPT the allowed ones
            find_args+=(-path "$item/*" "${exception_args[@]}" -prune -o)
        elif [[ "$item" == *"/"* ]]; then
            # Standard path prune
            find_args+=(-path "$item" -prune -o)
        else
            # Standard name prune
            find_args+=(-name "$item" -prune -o)
        fi
    done
}

# Apply PRUNES
add_prune_args "${PRUNES[@]}"

# Apply WEB_PRUNES
if [ ${#WEB_PRUNES[@]} -gt 0 ]; then
    add_prune_args "${WEB_PRUNES[@]}"
fi

# 5. Build Includes
if [ ${#INCLUDE_PATHS[@]} -gt 0 ]; then
    find_args+=(\()
    first=true
    for path in "${INCLUDE_PATHS[@]}"; do
        if [ "$first" = true ]; then
            first=false
        else
            find_args+=(-o)
        fi

        if [[ "$path" == "FLAT:"* ]]; then
            clean_path="${path#FLAT:}"
            find_args+=(\( -path "${clean_path}/*" -not -path "${clean_path}/*/*" \))
        else
            find_args+=(-path "$path")
        fi
    done
    find_args+=(\))
fi

# 6. Finalize: Ensure we only pick up files
find_args+=(-type f)

# ==========================================
# EXECUTION
# ==========================================

log "Starting recursive search and concatenation..."

find "${find_args[@]}" -print0 | while IFS= read -r -d '' file; do
    if [ -d "$file" ]; then continue; fi

    # Check size for logging
    if [[ "$OSTYPE" == "darwin"* ]]; then
        fsize=$(stat -f%z "$file")
    else
        fsize=$(stat -c%s "$file")
    fi
    fsize_kb=$((fsize / 1024))

    if [ "$fsize_kb" -gt 100 ]; then
        warn "Processing LARGE file (${fsize_kb}KB): $file"
    else
        echo -e "${GREEN}Processing:${NC} $file (${fsize} bytes)" >&2
    fi

    {
        echo "File: $file"
        echo "------------------------"
        # ✅ SAFELY stripped down to only remove `//` comments
        # Multiline `/*` stripping is too dangerous for RegEx in Lit components.
        if [[ "$file" == *.ts || "$file" == *.tsx || "$file" == *.js ]]; then
            cat "$file" | cat -s
        else
            cat "$file" | cat -s
        fi
        echo -e "\n\n"
    } >>"$TEMP_FILE"
done

# ==========================================
# ROOT FILES EXECUTION
# ==========================================

if [ ${#ROOT_EXTENSIONS[@]} -gt 0 ]; then
    echo "Concatenating root-level files..." >>"$TEMP_FILE"
    log "Finished recursive files. Starting root-level files..."

    root_args=(. -maxdepth 1 -type f \()
    first=true
    for ext in "${ROOT_EXTENSIONS[@]}"; do
        if [ "$first" = true ]; then
            root_args+=(-iname "$ext")
            first=false
        else
            root_args+=(-o -iname "$ext")
        fi
    done
    root_args+=(\))

    find "${root_args[@]}" -print0 | while IFS= read -r -d '' file; do
        if [ -d "$file" ]; then continue; fi

        # Skip artifacts
        case "$file" in
            "./$OUTPUT_FILE" | "./$CONFIG_FILE" | "./$SCRIPT_NAME" | "./$TEMP_FILE") continue ;;
        esac

        # Check explicit root excludes
        skip=false
        for exclude in "${ROOT_EXCLUDES[@]}"; do
            # shellcheck disable=SC2254
            case "$file" in
                $exclude | ./$exclude)
                    skip=true
                    break
                    ;;
            esac
        done

        if [ "$skip" = true ]; then continue; fi

        echo -e "${GREEN}Processing Root File:${NC} $file" >&2

        {
            echo "File: ${file#./}"
            echo "------------------------"
            # ✅ SAFELY stripped down to only remove `//` comments
            if [[ "$file" == *.ts || "$file" == *.tsx || "$file" == *.js ]]; then
                sed -e '/^[[:space:]]*\/\//d' "$file" | cat -s
            else
                cat "$file" | cat -s
            fi
            echo -e "\n\n"
        } >>"$TEMP_FILE"
    done
fi

# ==========================================
# FINALIZE
# ==========================================

mv "$TEMP_FILE" "$OUTPUT_FILE"
trap - EXIT

log "DONE! All files concatenated into $OUTPUT_FILE"
