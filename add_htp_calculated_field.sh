#!/bin/bash
# Script to add cf.is_htp_dataset calculated field to all datasets in the environment.
# Sets to true for HTP datasets: beekeeper, opamp-supervisor, primary-collector
# Sets to false for all other datasets.
#
# The API key is scoped to a specific environment, so no environment parameter needed.
#
# Required API key permissions:
# - "Manage Queries and Columns" (to create derived columns/calculated fields)
# - "Create Datasets" (to read/list datasets)
#
# Usage: ./add_htp_calculated_field.sh

set -e

if [ -z "$HONEYCOMB_API_KEY" ]; then
    echo "Error: HONEYCOMB_API_KEY environment variable not set"
    echo "The API key must have 'Manage Queries and Columns' and 'Create Datasets' permissions"
    exit 1
fi

# Function to create calculated field
create_calculated_field() {
    local dataset="$1"
    local is_htp="$2"
    
    echo "Creating cf.is_htp_dataset for $dataset = $is_htp"
    
    # Create expression that evaluates to boolean constant
    if [ "$is_htp" = "true" ]; then
        expression="COALESCE(true)"
    else
        expression="COALESCE(false)"
    fi
    
    response=$(curl -s -w "%{http_code}" -o /tmp/response.json \
        -X POST \
        -H "X-Honeycomb-Team: $HONEYCOMB_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{
            \"alias\": \"cf.is_htp_dataset\",
            \"description\": \"True if this dataset comes from Honeycomb Telemetry Pipeline (HTP)\",
            \"expression\": \"$expression\"
        }" \
        "https://api.honeycomb.io/1/derived_columns/$dataset")
    
    http_code="${response: -3}"
    
    if [ "$http_code" = "201" ]; then
        echo "✓ Created cf.is_htp_dataset for $dataset = $is_htp"
    elif [ "$http_code" = "409" ]; then
        echo "⚠ cf.is_htp_dataset already exists for $dataset"
    else
        echo "✗ Failed to create field for $dataset: HTTP $http_code"
        cat /tmp/response.json
        echo
    fi
}

# Function to get all datasets from the environment (API key scoped)
get_datasets() {
    echo "Retrieving datasets from environment..." >&2
    
    response=$(curl -s -w "%{http_code}" -o /tmp/datasets.json \
        -H "X-Honeycomb-Team: $HONEYCOMB_API_KEY" \
        "https://api.honeycomb.io/1/datasets")
    
    http_code="${response: -3}"
    
    if [ "$http_code" != "200" ]; then
        echo "✗ Failed to retrieve datasets: HTTP $http_code" >&2
        cat /tmp/datasets.json >&2
        exit 1
    fi
    
    # Extract dataset slugs from JSON response
    # This assumes the API returns an array of objects with 'slug' field
    # If the format is different, this will need to be adjusted
    cat /tmp/datasets.json | grep -o '"slug":"[^"]*"' | cut -d'"' -f4
}

# HTP datasets according to techContext.md
htp_datasets=("beekeeper" "opamp-supervisor" "primary-collector")

# Get all datasets from the environment dynamically
echo "Retrieving datasets from environment (API key scoped)..."
all_datasets=($(get_datasets))

echo "Adding cf.is_htp_dataset calculated field to ${#all_datasets[@]} datasets..."
echo "HTP datasets: ${htp_datasets[*]}"
echo

for dataset in "${all_datasets[@]}"; do
    # Check if dataset is in HTP list
    is_htp="false"
    for htp_dataset in "${htp_datasets[@]}"; do
        if [ "$dataset" = "$htp_dataset" ]; then
            is_htp="true"
            break
        fi
    done
    
    create_calculated_field "$dataset" "$is_htp"
    
    # Rate limiting: sleep 1 second between API calls to avoid hitting rate limits
    sleep 1
done

echo
echo "Done!"