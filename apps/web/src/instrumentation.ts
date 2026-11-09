/**
 * Runs once when the server starts. Node-only startup checks live in instrumentation-node.ts,
 * imported only on the Node.js runtime so the Edge compile never sees process.exit.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
