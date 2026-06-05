# Load .env file to get the database URL
if [ -f ./.env ]; then
    # -a tells the shell to export all variables defined from here on
    set -a
    source ./.env
    set +a
else
    echo "⚠️ .env file not found. Assuming DATABASE_URL_LOCAL is in the environment."
fi
