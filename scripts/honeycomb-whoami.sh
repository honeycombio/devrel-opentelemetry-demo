#!/bin/bash

#
# honeycomb-whoami
# read $HONEYCOMB_API_KEY and print a link to the team and environment
#
source $(git rev-parse --show-toplevel)/.env

# Check if HONEYCOMB_API_KEY is set
if [ -z "$HONEYCOMB_API_KEY" ]; then
  echo "no HONEYCOMB_API_KEY environment variable"
  exit 0 # this is not an error, just the state of things
fi

# Make the API request to Honeycomb Auth endpoint
response=$(curl -s -H "X-Honeycomb-Team: $HONEYCOMB_API_KEY" \
                 "https://api.honeycomb.io/1/auth")

# Check if the curl command executed at all
if [ $? -ne 0 ]; then
  echo "Error: Failed to fetch data from Honeycomb API."
  exit 1
fi  

# Check whether $response containst "401"
if [[ $response == *"401"* ]]; then
  echo "This Honeycomb API key is not valid: $HONEYCOMB_API_KEY"
  exit 1
fi


###
# this requires 'jq' to parse the json response.
# Testing with the Java repo, I observe that Codespaces has jq installed.
# So does gitpod. I didn't do anything special to configure these.
# If people run this locally, they can choose how to install it, or not.
# 
if ! command -v jq &> /dev/null; then
  echo "if `jq` were installed, I'd link you to your Honeycomb environment."
  echo "Instead, here is the response from the Honeycomb auth API:"
  echo $response
  exit 0
fi

# Extract the team slug and environment slug from the response using jq
team_slug=$(echo "$response" | jq -r '.team.slug')
env_slug=$(echo "$response" | jq -r '.environment.slug')

# Check if slugs were found
if [ -z "$team_slug" ] || [ -z "$env_slug" ]; then
  echo "Error: Unable to extract team or environment slug from response."
  exit 1
fi

# Construct and output a URL to dataset home
dataset_home_url="https://ui.honeycomb.io/${team_slug}/environments/${env_slug}/datasets/backend-for-frontend/home"
echo "############"
echo "### Look for data in Honeycomb: $dataset_home_url"
