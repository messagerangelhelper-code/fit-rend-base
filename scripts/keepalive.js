// Oracle can take back a free server that looks idle for 7 days.
// This keeps a small, steady load on the processor so the server is not idle.
// KEEPALIVE_CPU is the share of one processor core to use (0.5 = half a core). Set it to 0 to turn this off.
const share = Math.min(0.9, Math.max(0, Number(process.env.KEEPALIVE_CPU ?? 0.5)));
console.log('keepalive using', share, 'of one core');
if (share > 0) {
  setInterval(() => {
    const end = Date.now() + share * 1000;
    let x = 0;
    while (Date.now() < end) x = Math.sqrt(x + 1);
  }, 1000);
} else setInterval(() => {}, 3600000);
