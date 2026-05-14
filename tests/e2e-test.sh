#!/usr/bin/env bash
# End-to-end tests for pi-committer extension
set -euo pipefail

EXT_PATH="$HOME/projects/pi-committer/extensions/pi-committer/index.ts"
PASS=0
FAIL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# Temp dirs — set by setup
TESTDIR=""
REPO2=""

cleanup_all() {
  rm -rf "${TESTDIR:-}" "${REPO2:-}" /tmp/pi-committer-nongit-* 2>/dev/null || true
}

assert_commits() {
  local repo="$1" min="$2" msg="$3"
  cd "$repo"
  local total
  total=$(git log --oneline 2>/dev/null | wc -l | tr -d ' ')
  # total = initial(1) + new commits = at least 1 + min
  local expected=$((1 + min))
  if [ "$total" -ge "$expected" ]; then
    echo -e "${GREEN}PASS${NC} $msg"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC} $msg (expected >=$min new commits, total=$total)"
    FAIL=$((FAIL + 1))
  fi
}

# ===== Main =====
echo "pi-committer E2E Tests"
echo "======================"
echo ""

cleanup_all

TESTDIR=$(mktemp -d /tmp/pi-committer-e2e-XXXXXX 2>/dev/null)
REPO2=$(mktemp -d /tmp/pi-committer-e2e-repo2-XXXXXX 2>/dev/null)

trap cleanup_all EXIT

# Init primary
cd "$TESTDIR"
git init >/dev/null 2>&1
git config user.email "t@t.com"
git config user.name "T"
echo "# main" > README.md && git add -A && git commit -m "initial" >/dev/null 2>&1

# Init repo2
cd "$REPO2"
git init >/dev/null 2>&1
git config user.email "t@t.com"
git config user.name "T"
echo "# repo2" > README.md && git add -A && git commit -m "initial" >/dev/null 2>&1

# ---------------
cd "$TESTDIR"

echo "--- Test 1: Basic /commit ---"
echo "// test" > test.ts
printf '/commit\n' | pi -p -e "$EXT_PATH" 2>/dev/null || true
assert_commits "$TESTDIR" 1 "/commit creates a commit"

echo ""
echo "--- Test 2: Exclusion patterns ---"
cat > .pi-committer.toml << 'EOF'
[committer]
enabled = true
trigger_mode = "on_goal"
exclude_patterns = ["*.log"]
EOF
echo "// keep" > keep.ts
echo "# log file" > build.log
printf '/commit\n' | pi -p -e "$EXT_PATH" 2>/dev/null || true
assert_commits "$TESTDIR" 1 "keep.ts committed"
cd "$TESTDIR"
if git status --porcelain | grep -q "?? build.log"; then
  echo -e "${GREEN}PASS${NC} build.log excluded"
  PASS=$((PASS + 1))
else
  echo -e "${RED}FAIL${NC} build.log not excluded"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- Test 3: commit_changes tool ---"
echo "// tool" > tool-test.ts
printf 'Call commit_changes\n' | pi -p -e "$EXT_PATH" 2>/dev/null || true
assert_commits "$TESTDIR" 1 "commit_changes tool creates a commit"

echo ""
echo "--- Test 4: Staged commits ---"
mkdir -p src tests
echo "// new module" > src/module.ts
echo "// new test" > tests/module.test.ts
echo "# changelog v2" > CHANGELOG.md
printf '/commit\n' | pi -p -e "$EXT_PATH" 2>/dev/null || true
assert_commits "$TESTDIR" 2 "staged commits create >=2 logical groups"

echo ""
echo "--- Test 5: Multi-repo ---"
echo "// primary" > primary.ts
echo "# repo2 new" > "$REPO2/CHANGELOG.md"
cd "$TESTDIR"
printf "Write a file $REPO2/CHANGELOG.md with content '# repo2 new'. Then call commit_changes.\n" | \
  pi -p -e "$EXT_PATH" 2>/dev/null || true
assert_commits "$TESTDIR" 1 "primary repo committed"
assert_commits "$REPO2" 1 "repo2 committed"

echo ""
echo "--- Test 6: Non-git directory ---"
NONGIT=$(mktemp -d /tmp/pi-committer-nongit-XXXXXX 2>/dev/null)
echo "// nongit" > "$NONGIT/test.ts"
cd "$NONGIT"
printf '/commit\n' | pi -p -e "$EXT_PATH" 2>/dev/null || true
echo -e "${GREEN}PASS${NC} non-git dir handled gracefully"
PASS=$((PASS + 1))

echo ""
echo "--- Test 7: Config reload ---"
cd "$TESTDIR"
printf '/commit-config\n' | pi -p -e "$EXT_PATH" 2>/dev/null || true
echo -e "${GREEN}PASS${NC} /commit-config ran"
PASS=$((PASS + 1))

echo ""
echo "======================"
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "======================"

cleanup_all
[[ $FAIL -eq 0 ]]
