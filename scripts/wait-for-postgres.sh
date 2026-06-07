# Load .env file to get the database URL
if [ -f ./.env ]; then
    # Load env variables without overwriting already defined ones
    while IFS= read -r line || [ -n "$line" ]; do
        # Remove carriage returns if any
        line="${line//$'\r'/}"
        # Skip comments and empty lines
        if [[ "$line" =~ ^[[:space:]]*# ]] || [[ -z "${line// /}" ]]; then
            continue
        fi
        key=$(echo "$line" | cut -d'=' -f1 | xargs)
        val=$(echo "$line" | cut -d'=' -f2- | xargs)
        if [ -n "$key" ]; then
            if ! env | grep -q "^$key="; then
                export "$key=$val"
            fi
        fi
    done <.env
else
    echo "⚠️ .env file not found. Assuming DATABASE_URL_LOCAL is in the environment."
fi
