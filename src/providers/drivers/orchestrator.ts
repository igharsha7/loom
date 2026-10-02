export const ORCHESTRATOR_VERIFY_TOOLS = [
  "npm test", "npm run test", "npm run build", "npm run typecheck", "npm run lint",
  "pnpm test", "yarn test", "bun test", "node --test", "npx vitest run", "npx tsc --noEmit",
  "cargo test", "cargo check", "go test", "go build", "pytest", "python -m pytest",
  "git log", "git diff", "git status", "git show",
].map((c) => `Bash(${c}:*)`);

