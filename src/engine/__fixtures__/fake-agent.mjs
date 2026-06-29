// Stub agent. Behavior controlled by argv:
//   node fake-agent.mjs ok       -> exits 0 immediately
//   node fake-agent.mjs hang     -> never exits (until killed)
const mode = process.argv[2];
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
