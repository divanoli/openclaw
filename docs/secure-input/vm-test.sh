#!/usr/bin/env bash
# VM Test Script for OpenClaw Secure Secret Feature
# Run after vm-setup.sh completes
set -euo pipefail

cd "$HOME/openclaw"

PASS=0
FAIL=0
SKIP=0

pass() { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }
skip() { echo "  ⏭️  $1"; ((SKIP++)); }
header() { echo ""; echo "=== $1 ==="; }

header "1. Unit Tests (144 expected)"
if npx vitest run \
  src/auto-reply/reply/commands-secret.test.ts \
  src/agents/auth-profiles/profiles.test.ts \
  src/auto-reply/reply/inbound-context-secrets.test.ts \
  src/config/env-substitution.test.ts \
  src/agents/model-auth.test.ts \
  2>&1 | tee /tmp/vitest-output.txt | tail -5; then
  pass "All unit tests passed"
else
  fail "Unit tests had failures — check /tmp/vitest-output.txt"
fi

header "2. Build Check"
if pnpm build 2>&1 | tail -3; then
  pass "Build succeeded"
else
  fail "Build failed"
fi

header "3. Type Check"
if npx tsgo 2>&1 | tail -3; then
  pass "Type check passed"
else
  fail "Type check failed"
fi

header "4. Lint Check"
if pnpm lint 2>&1 | tail -3; then
  pass "Lint passed"
else
  fail "Lint failed"
fi

header "5. Import Verification"
echo "  Checking that secret functions are properly exported..."
node --import tsx -e "
  import { upsertSecretValue, getSecretValue, listSecretKeys, deleteSecretValue } from './src/agents/auth-profiles.js';
  console.log('  Exported functions:', typeof upsertSecretValue, typeof getSecretValue, typeof listSecretKeys, typeof deleteSecretValue);
  if ([upsertSecretValue, getSecretValue, listSecretKeys, deleteSecretValue].every(f => typeof f === 'function')) {
    console.log('  All 4 secret CRUD functions exported correctly');
    process.exit(0);
  } else {
    console.error('  Missing exports!');
    process.exit(1);
  }
" 2>&1 && pass "Secret CRUD exports verified" || fail "Secret CRUD export check failed"

header "6. Command Registration Verification"
node --import tsx -e "
  import { buildChatCommands } from './src/auto-reply/commands-registry.data.js';
  const cmds = buildChatCommands();
  const secret = cmds.find(c => c.key === 'secret');
  if (!secret) { console.error('  /secret command not registered!'); process.exit(1); }
  console.log('  /secret command found:', secret.key, '— category:', secret.category);

  const alias = cmds.find(c => c.key === 's' || c.nativeName === 's');
  console.log('  /s alias:', alias ? 'found' : 'checking via aliases...');
  process.exit(0);
" 2>&1 && pass "Command registration verified" || fail "Command registration check failed"

header "7. RESERVED_COMMANDS Check"
node --import tsx -e "
  // Verify 'secret' and 's' are in RESERVED_COMMANDS by checking the source
  const fs = await import('fs');
  const src = fs.readFileSync('src/plugins/commands.ts', 'utf8');
  const hasSecret = src.includes('\"secret\"');
  const hasS = src.includes('\"s\"');
  console.log('  RESERVED_COMMANDS includes \"secret\":', hasSecret);
  console.log('  RESERVED_COMMANDS includes \"s\":', hasS);
  if (!hasSecret || !hasS) { process.exit(1); }
  process.exit(0);
" 2>&1 && pass "RESERVED_COMMANDS includes secret + s" || fail "RESERVED_COMMANDS missing entries"

header "8. Handler Order Check"
node --import tsx -e "
  const fs = await import('fs');
  const src = fs.readFileSync('src/auto-reply/reply/commands-core.ts', 'utf8');
  const handlersMatch = src.match(/HANDLERS\s*=\s*\[([\s\S]*?)\]/);
  if (!handlersMatch) { console.error('  Could not find HANDLERS array'); process.exit(1); }
  const handlers = handlersMatch[1];
  const lines = handlers.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
  console.log('  First handler:', lines[0]);
  if (lines[0].includes('handleSecretCommand')) {
    console.log('  handleSecretCommand is FIRST in HANDLERS array');
    process.exit(0);
  } else {
    console.error('  handleSecretCommand is NOT first!');
    process.exit(1);
  }
" 2>&1 && pass "handleSecretCommand is first in HANDLERS" || fail "Handler order incorrect"

header "9. \$SECRET: Resolution in env-substitution"
node --import tsx -e "
  const fs = await import('fs');
  const src = fs.readFileSync('src/config/env-substitution.ts', 'utf8');
  if (src.includes('\$SECRET:')) {
    console.log('  \$SECRET: handler found in env-substitution.ts');
    process.exit(0);
  } else {
    console.error('  \$SECRET: handler missing!');
    process.exit(1);
  }
" 2>&1 && pass "\$SECRET: resolution present in env-substitution" || fail "\$SECRET: handler missing"

header "10. Store Functions Include Secrets Field"
node --import tsx -e "
  const fs = await import('fs');
  const src = fs.readFileSync('src/agents/auth-profiles/store.ts', 'utf8');
  const checks = [
    ['coerceAuthStore has secrets', /secrets.*record\.secrets/s.test(src)],
    ['mergeAuthProfileStores has secrets', /secrets.*mergeRecord.*secrets/s.test(src) || /secrets:.*base\.secrets.*override\.secrets/s.test(src)],
    ['saveAuthProfileStore has secrets', /secrets:.*store\.secrets/s.test(src)],
  ];
  let ok = true;
  for (const [label, result] of checks) {
    console.log('  ' + label + ':', result ? '✓' : '✗');
    if (!result) ok = false;
  }
  process.exit(ok ? 0 : 1);
" 2>&1 && pass "Store functions include secrets field" || fail "Store functions missing secrets"

# Summary
header "RESULTS"
echo ""
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Skipped: $SKIP"
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "  🎉 ALL CHECKS PASSED — ready for community proposal"
else
  echo "  ⚠️  $FAIL check(s) failed — review above output"
fi
