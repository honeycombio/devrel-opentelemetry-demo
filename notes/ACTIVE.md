# Current Task

This file is for active work. Put output and plans here.
When you complete an item, test it! then check it off here and then make a commit.

## what are we working on?

✅ Write a temporary script to:

- ✅ use the Honeycomb API
- ✅ assume $HONEYCOMB_API_KEY exists with the right permissions
- ✅ IN Honeycomb environment azure-otel-demo-pipeline, for each dataset, create a calculated field called cf.is_htp_dataset
- ✅ See techContext.md for which ones should be true. Document the field there.

## Completed Work

Created script:

`add_htp_calculated_field.sh` - Bash version using curl

The bash script will:

- Check for HONEYCOMB_API_KEY environment variable
- Create cf.is_htp_dataset calculated field for all 35 datasets
- Set to `true` for HTP datasets: beekeeper, opamp-supervisor, primary-collector
- Set to `false` for all other datasets

Documentation added to techContext.md explaining the calculated field.

To run: `./add_htp_calculated_field.sh`

## tweaks

✅ make it retrieve all datasets dynamically, so it can be run on environments other than this one.
✅ document which permissions the API key needs

## Updated Script

Enhanced `add_htp_calculated_field.sh`:

- Dynamically retrieves all datasets from the environment (API key is scoped to one environment)
- Documents required API key permissions in header
- Usage: `./add_htp_calculated_field.sh` (no parameters needed)

Required API key permissions:

- "Manage Queries and Columns" (to create derived columns/calculated fields)
- "Create Datasets" (to read/list datasets)

## Final Fix

Removed environment parameter since API keys are scoped to a specific environment automatically.

## Testing Results

Tested script with test API key:

- ✅ Script successfully retrieves datasets (41 datasets found)
- ✅ Fixed `mapfile` compatibility issue for older bash versions
- ❌ Expression syntax for boolean values needs fixing - Honeycomb expects specific expression format
- ❌ Hit rate limits during testing (41 API calls quickly)

## Fixes Applied

✅ Fixed boolean expression syntax using `COALESCE(true)` / `COALESCE(false)`
✅ Added 1-second delay between API calls to avoid rate limits

Script is now ready for production use.

## Production Deployment

✅ **COMPLETED**: Script executed successfully on azure-otel-demo-pipeline environment
✅ Created cf.is_htp_dataset calculated field on all 35 datasets
✅ HTP datasets correctly set to `true`: beekeeper, opamp-supervisor, primary-collector
✅ All other 32 datasets correctly set to `false`
✅ Task complete!
