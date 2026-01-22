#!/bin/bash
# Bump the release version tag
# Usage: ./scripts/bump-release.sh <major|minor|patch>

set -e

BUMP_TYPE="${1:-}"

if [[ -z "$BUMP_TYPE" ]]; then
    echo "Usage: $0 <major|minor|patch>"
    echo ""
    echo "Examples:"
    echo "  $0 patch   # 2.2.7-release -> 2.2.8-release"
    echo "  $0 minor   # 2.2.7-release -> 2.3.0-release"
    echo "  $0 major   # 2.2.7-release -> 3.0.0-release"
    exit 1
fi

if [[ "$BUMP_TYPE" != "major" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "patch" ]]; then
    echo "Error: Invalid bump type '$BUMP_TYPE'. Must be one of: major, minor, patch"
    exit 1
fi

# Get the latest release tag
LATEST_TAG=$(git tag --list '*.*.*-release' | sort -V | tail -1)

if [[ -z "$LATEST_TAG" ]]; then
    echo "Error: No existing release tags found matching pattern '*.*.*-release'"
    echo "Please create an initial tag manually, e.g.: git tag 0.0.1-release"
    exit 1
fi

echo "Current version: $LATEST_TAG"

# Extract version numbers (remove -release suffix)
VERSION="${LATEST_TAG%-release}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# Bump the appropriate version
case "$BUMP_TYPE" in
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0
        PATCH=0
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0
        ;;
    patch)
        PATCH=$((PATCH + 1))
        ;;
esac

NEW_TAG="${MAJOR}.${MINOR}.${PATCH}-release"

echo "New version: $NEW_TAG"
echo ""

# Confirm with user
read -p "Create and push tag '$NEW_TAG'? [y/N] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    git tag "$NEW_TAG"
    echo "Created tag: $NEW_TAG"
    
    read -p "Push tag to origin? [y/N] " -n 1 -r
    echo ""
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git push origin "$NEW_TAG"
        echo "Pushed tag: $NEW_TAG"
    else
        echo "Tag created locally. Push manually with: git push origin $NEW_TAG"
    fi
else
    echo "Aborted."
    exit 0
fi

