// Starts the campaign sender when the server starts, so a campaign keeps going after a restart.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startEngine } = await import('./lib/crm');
    startEngine();
  }
}
